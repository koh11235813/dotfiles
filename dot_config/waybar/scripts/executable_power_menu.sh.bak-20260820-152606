#!/bin/bash

options="Lock\nSuspend\nLogout\nReboot\nShutdown"

selected=$(echo -e "$options" | rofi -dmenu -i -p "Power" -theme-str 'window {width: 200px;} listview {lines: 5;}')

case "$selected" in
    Lock)     loginctl lock-session ;;
    Suspend)  systemctl suspend ;;
    Logout)   hyprctl dispatch exit ;;
    Reboot)   systemctl reboot ;;
    Shutdown) systemctl poweroff ;;
esac
