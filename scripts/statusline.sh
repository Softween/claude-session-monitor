#!/bin/bash
# Claude Code statusLine for the Session Monitor.
# Captures the account rate-limit budget (5h / 7d) that Claude Code passes on
# stdin and writes it where the VS Code extension can chart it. Must be fast:
# bash + jq only, no python/node startup cost.
#
#   ~/.claude/session-monitor/limits.json          latest snapshot (atomic)
#   ~/.claude/session-monitor/limits-history.jsonl  throttled time series (<=1/min)
#   ~/.claude/session-monitor/statusline-last-raw.json  last raw payload (schema/debug, atomic)
#
# Prints a compact English status line for the Claude UI.

dir="$HOME/.claude/session-monitor"
mkdir -p "$dir" 2>/dev/null
in="$(cat)"

# Replace file $1 with text $2 through a unique temp file in the same folder and
# a rename: every open session renders through this script, often at once, so a
# reader never sees a half-written file and two renders never share a temp file.
put() {
  local tmp
  tmp="$(mktemp "$(dirname "$1")/.$(basename "$1").XXXXXX" 2>/dev/null)" || return 1
  if printf '%s' "$2" > "$tmp" 2>/dev/null && mv -f "$tmp" "$1" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null
  return 1
}

put "$dir/statusline-last-raw.json" "$in"

vals="$(printf '%s' "$in" | /usr/bin/jq -c '{
  fh: .rate_limits.five_hour.utilization,
  fh_reset: .rate_limits.five_hour.resets_at,
  sd: .rate_limits.seven_day.utilization,
  sd_reset: .rate_limits.seven_day.resets_at,
  sds: .rate_limits.seven_day_sonnet.utilization,
  sds_reset: .rate_limits.seven_day_sonnet.resets_at,
  model: (.model.display_name // .model.id // (.model | tostring)),
  ts: now
}' 2>/dev/null)"

if [ -n "$vals" ] && [ "$vals" != "null" ]; then
  has=$(printf '%s' "$vals" | /usr/bin/jq -r '(.fh // .sd // .sds) != null' 2>/dev/null)
  if [ "$has" = "true" ]; then
    put "$dir/limits.json" "$vals"
    hist="$dir/limits-history.jsonl"
    if [ ! -f "$hist" ] || [ -z "$(/usr/bin/find "$hist" -mmin -1 2>/dev/null)" ]; then
      # Tag the point with the active account so multi-account charts stay
      # attributed after a login switch. Only in this <=1/min branch: parsing
      # the (possibly large) ~/.claude.json on every render would be too slow.
      acct="$(/usr/bin/jq -r '.oauthAccount.accountUuid // empty' "$HOME/.claude.json" 2>/dev/null)"
      if [ -n "$acct" ]; then
        vals="$(printf '%s' "$vals" | /usr/bin/jq -c --arg a "$acct" '. + {acct:$a}' 2>/dev/null || printf '%s' "$vals")"
      fi
      printf '%s\n' "$vals" >> "$hist" 2>/dev/null
    fi
  fi
fi

line="$(printf '%s' "$in" | /usr/bin/jq -r '
  def pct(x): if x==null then "-" elif x<=1 then ((x*100)|floor|tostring) else (x|floor|tostring) end;
  "Claude  5h " + pct(.rate_limits.five_hour.utilization) + "%  ·  7d " + pct(.rate_limits.seven_day.utilization) + "%"
' 2>/dev/null)"
# Optional ctxgov segment (live context size / request count / fixed prefix), only
# where the local ctxgov tool is installed. Cached for 60s (find -mmin -1, same
# throttle idiom as the limits-history write above) so a render, which happens on
# every prompt/tool-use, does not pay a python3 startup cost each time.
seg=""
ctxgov="$HOME/.claude/ctxgov/ctxgov.py"
if [ -f "$ctxgov" ]; then
  ctxcache="${TMPDIR:-/tmp}/claude-statusline-ctxgov.cache"
  if [ -f "$ctxcache" ] && [ -n "$(/usr/bin/find "$ctxcache" -mmin -1 2>/dev/null)" ]; then
    seg="$(cat "$ctxcache" 2>/dev/null)"
  else
    seg="$(/opt/homebrew/bin/python3 "$ctxgov" statusline "$dir/statusline-last-raw.json" 2>/dev/null)"
    put "$ctxcache" "$seg"
  fi
fi
if [ -n "$seg" ]; then printf '%s  ·  %s' "$line" "$seg"; else printf '%s' "$line"; fi
