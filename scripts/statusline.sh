#!/bin/bash
# Claude Code statusLine for the Session Monitor.
# Captures the account rate-limit budget (5h / 7d) that Claude Code passes on
# stdin and writes it where the VS Code extension can chart it. Must be fast:
# bash + jq only, no python/node startup cost.
#
#   ~/.claude/session-monitor/limits.json          latest snapshot (atomic)
#   ~/.claude/session-monitor/limits-history.jsonl  throttled time series (<=1/min)
#   ~/.claude/session-monitor/statusline-last-raw.json  last raw payload (schema/debug)
#
# Prints a compact English status line for the Claude UI.

dir="$HOME/.claude/session-monitor"
mkdir -p "$dir" 2>/dev/null
in="$(cat)"
printf '%s' "$in" > "$dir/statusline-last-raw.json" 2>/dev/null

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
    printf '%s' "$vals" > "$dir/limits.json.tmp" 2>/dev/null && mv "$dir/limits.json.tmp" "$dir/limits.json" 2>/dev/null
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

printf '%s' "$in" | /usr/bin/jq -r '
  def pct(x): if x==null then "-" elif x<=1 then ((x*100)|floor|tostring) else (x|floor|tostring) end;
  "Claude  5h " + pct(.rate_limits.five_hour.utilization) + "%  ·  7d " + pct(.rate_limits.seven_day.utilization) + "%"
' 2>/dev/null
