<!-- Pi overlay. -->
<!-- agmsg:slot delivery -->
<!-- agmsg:render-overlay __AGENT_TYPE__ -->
  5. Pi has no automatic delivery mode. Keep delivery `off` and check `__CMD_PREFIX____SKILL_NAME__` manually.
<!-- /agmsg:slot delivery -->
<!-- agmsg:slot execute-extra -->
pi is not spawnable: there is no verified invocation that starts an interactive pi session pre-seeded with an initial prompt, so `spawn` is refused rather than pretending to start a seat.
<!-- /agmsg:slot execute-extra -->
<!-- agmsg:slot mode -->
If argument is "mode", run `delivery.sh status __AGENT_TYPE__ "$(pwd)"`.
Only `off` is supported for Pi; reject `monitor`, `turn`, and `both`.
<!-- /agmsg:slot mode -->
