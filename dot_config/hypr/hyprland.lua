-- Migrated from hyprland.conf (hyprlang) to the Lua config API.
-- Stubs: /usr/share/hypr/stubs/hl.meta.lua / Example: /usr/share/hypr/hyprland.lua
-- https://wiki.hypr.land/Configuring/Start/

------------------
---- MONITORS ----
------------------

hl.monitor({ output = "DP-2",     mode = "1920x1080@143.98", position = "0x0",     scale = 1 })
hl.monitor({ output = "DP-3",     mode = "1920x1080@165.00", position = "1920x0",  scale = 1 })
hl.monitor({ output = "HDMI-A-3", mode = "1920x1080@119.88", position = "-1920x0", scale = 1 })

---------------------
---- MY PROGRAMS ----
---------------------

local terminal    = "kitty"
local fileManager = "nautilus"
local menu        = "sherlock --multi"

-------------------
---- AUTOSTART ----
-------------------

-- exec-once equivalent: runs only at compositor startup, not on reloads
hl.on("hyprland.start", function()
    hl.exec_cmd("waybar")
    hl.exec_cmd("mako")
    hl.exec_cmd("fcitx5-remote -r")
    hl.exec_cmd("fcitx5 -d --replace")
    hl.exec_cmd("/usr/lib/hyprpolkitagent")
    hl.exec_cmd("discord")
    hl.exec_cmd("steam")
    hl.exec_cmd("hypridle")
    hl.exec_cmd("openrgb")
    -- systemdへ環境伝搬（1回でOK）
    hl.exec_cmd("dbus-update-activation-environment --systemd --all")
end)

-- exec equivalent: runs on startup AND on every config reload
hl.exec_cmd('"${XDG_CONFIG_HOME:-${HOME}/.config}/hypr/scripts/init-gtk.sh"')

-------------------------------
---- ENVIRONMENT VARIABLES ----
-------------------------------

hl.env("XCURSOR_SIZE", "24")
hl.env("HYPRCURSOR_SIZE", "24")
hl.env("QT_QPA_PLATFORM", "wayland;xcb")

-- fcitx5
hl.env("GTK_IM_MODULE", "fcitx")
hl.env("QT_IM_MODULE", "fcitx")
hl.env("XMODIFIERS", "@im=fcitx")
hl.env("SDL_IM_MODULE", "fcitx")
hl.env("GLFW_IM_MODULE", "ibus")

-----------------------
---- LOOK AND FEEL ----
-----------------------

hl.config({
    general = {
        gaps_out    = 10,
        gaps_in     = 5,
        border_size = 2,
        col = {
            active_border   = { colors = { "rgba(33ccffee)", "rgba(00ff99ee)" }, angle = 45 },
            inactive_border = "rgba(595959aa)",
        },
        resize_on_border = false,
        allow_tearing    = false,
        layout           = "dwindle",
    },

    decoration = {
        rounding         = 10,
        rounding_power   = 2,
        active_opacity   = 1.0,
        inactive_opacity = 1.0,
        shadow = {
            enabled      = true,
            range        = 4,
            render_power = 3,
            color        = "rgba(1a1a1aee)",
        },
        blur = {
            enabled        = true,
            size           = 8,
            passes         = 3,
            ignore_opacity = true,
        },
    },

    animations = { enabled = true },

    dwindle = { preserve_split = true },
    master  = { new_status = "master" },

    misc = {
        force_default_wallpaper = -1,
        disable_hyprland_logo   = false,
    },

    xwayland = { force_zero_scaling = true },

    input = {
        kb_layout      = "us",
        kb_options     = "ctrl:nocaps,altwin:swap_alt_win",
        force_no_accel = true,
        natural_scroll = true,
        follow_mouse   = 1,
        sensitivity    = 0,
        accel_profile  = "flat",
        repeat_rate    = 35,
        repeat_delay   = 200, -- (ms)
        touchpad = { natural_scroll = true },
    },
})

hl.layer_rule({
    name  = "waybar_blur",
    match = { namespace = "waybar" },
    blur  = true,
    ignore_alpha = 0.3,
})

-- animations: myBezier + windows/workspaces only (same as .conf)
hl.curve("myBezier", { type = "bezier", points = { { 0.05, 0.9 }, { 0.1, 1.05 } } })
hl.animation({ leaf = "windows",    enabled = true, speed = 7,   bezier = "myBezier" })
hl.animation({ leaf = "workspaces", enabled = true, speed = 1.9, bezier = "myBezier", style = "fade" })

---------------
---- INPUT ----
---------------

hl.gesture({ fingers = 3, direction = "horizontal", action = "workspace" })

hl.device({ name = "epic-mouse-v1", sensitivity = -0.5 })

---------------------
---- KEYBINDINGS ----
---------------------

local mainMod = "SUPER"

hl.bind(mainMod .. " + Return", hl.dsp.exec_cmd(terminal))
hl.bind(mainMod .. " + Q",      hl.dsp.window.close())
hl.bind(mainMod .. " + SPACE",  hl.dsp.exec_cmd(menu))
hl.bind(mainMod .. " + P",      hl.dsp.window.pseudo())
hl.bind(mainMod .. " + F",      hl.dsp.exec_cmd("firefox"))
hl.bind(mainMod .. " + D",      hl.dsp.exec_cmd("discord"))
hl.bind(mainMod .. " + O",      hl.dsp.exec_cmd("osu"))
hl.bind(mainMod .. " + E",      hl.dsp.exec_cmd(fileManager))
hl.bind(mainMod .. " + B",      hl.dsp.window.float({ action = "toggle" }))
hl.bind(mainMod .. " + L",      hl.dsp.exec_cmd("loginctl lock-session"))

-- screenshot binds, requires grim, slurp, wl-copy, wl-paste
local regionShot = [[sh -c 'REGION=$(slurp) || exit; grim -g "$REGION" - | wl-copy && wl-paste > ~/Pictures/screenshots/Screenshot-$(date +%F_%T).png && notify-send "Region screenshot saved"']]
local monitorShot = [[sh -c 'MON=$(hyprctl monitors -j | jq -r ".[] | select(.focused) | .name") || exit; grim -o "$MON" - | wl-copy && wl-paste > ~/Pictures/screenshots/Screenshot-$(date +%F_%T).png && notify-send "Monitor screenshot saved"']]
hl.bind("Print",                    hl.dsp.exec_cmd(regionShot))
hl.bind("SHIFT + Print",            hl.dsp.exec_cmd([[grim - | wl-copy && wl-paste > ~/Pictures/screenshots/Screenshot-$(date +%F_%T).png && notify-send "Full screenshot saved"]]))
hl.bind(mainMod .. " + SHIFT + S",  hl.dsp.exec_cmd(regionShot))
hl.bind(mainMod .. " + CTRL + SHIFT + S", hl.dsp.exec_cmd(monitorShot))

-- Move focus with mainMod + arrow keys
hl.bind(mainMod .. " + left",  hl.dsp.focus({ direction = "left" }))
hl.bind(mainMod .. " + right", hl.dsp.focus({ direction = "right" }))
hl.bind(mainMod .. " + up",    hl.dsp.focus({ direction = "up" }))
hl.bind(mainMod .. " + down",  hl.dsp.focus({ direction = "down" }))

hl.bind(mainMod .. " + SHIFT + F", hl.dsp.window.fullscreen())
hl.bind(mainMod .. " + SHIFT + M", hl.dsp.exit())

-- Switch / move-to workspaces with mainMod (+ SHIFT) + [0-9]
for i = 1, 10 do
    local key = i % 10 -- 10 maps to key 0
    hl.bind(mainMod .. " + " .. key,            hl.dsp.focus({ workspace = i }))
    hl.bind(mainMod .. " + SHIFT + " .. key,    hl.dsp.window.move({ workspace = i }))
end

-- Scroll through existing workspaces with mainMod + scroll
hl.bind(mainMod .. " + mouse_down", hl.dsp.focus({ workspace = "e+1" }))
hl.bind(mainMod .. " + mouse_up",   hl.dsp.focus({ workspace = "e-1" }))

-- Move/resize windows with mainMod + LMB/RMB and dragging (bindm)
hl.bind(mainMod .. " + mouse:272", hl.dsp.window.drag())
hl.bind(mainMod .. " + mouse:273", hl.dsp.window.resize())

-- Multimedia keys (bindel = locked + repeating)
hl.bind("XF86AudioRaiseVolume",             hl.dsp.exec_cmd("wpctl set-volume -l 1.2 @DEFAULT_AUDIO_SINK@ 5%+"),   { locked = true, repeating = true })
hl.bind("XF86AudioLowerVolume",             hl.dsp.exec_cmd("wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-"),          { locked = true, repeating = true })
hl.bind(mainMod .. " + XF86AudioRaiseVolume", hl.dsp.exec_cmd("wpctl set-volume -l 1.5 @DEFAULT_AUDIO_SOURCE@ 5%+"), { locked = true, repeating = true })
hl.bind(mainMod .. " + XF86AudioLowerVolume", hl.dsp.exec_cmd("wpctl set-volume @DEFAULT_AUDIO_SOURCE@ 5%-"),        { locked = true, repeating = true })
hl.bind("XF86AudioMute",                    hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"),         { locked = true, repeating = true })
hl.bind("XF86AudioMicMute",                 hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle"),       { locked = true, repeating = true })
hl.bind("XF86MonBrightnessUp",              hl.dsp.exec_cmd("brightnessctl -e4 -n2 set 5%+"),                      { locked = true, repeating = true })
hl.bind("XF86MonBrightnessDown",            hl.dsp.exec_cmd("brightnessctl -e4 -n2 set 5%-"),                      { locked = true, repeating = true })

-- Requires playerctl (bindl = locked)
hl.bind("XF86AudioNext",  hl.dsp.exec_cmd("playerctl next"),       { locked = true })
hl.bind("XF86AudioPause", hl.dsp.exec_cmd("playerctl play-pause"), { locked = true })
hl.bind("XF86AudioPlay",  hl.dsp.exec_cmd("playerctl play-pause"), { locked = true })
hl.bind("XF86AudioPrev",  hl.dsp.exec_cmd("playerctl previous"),   { locked = true })

--------------------------------
---- WINDOWS AND WORKSPACES ----
--------------------------------

hl.window_rule({ name = "osu-ws",        match = { class = "osu!" },                       workspace = "8" })
hl.window_rule({ name = "beatoraja-ws",  match = { class = "beatoraja 0.8.8" },            workspace = "8" })
hl.window_rule({ name = "discord-ws",    match = { class = "discord" },                    workspace = "3" })
hl.window_rule({ name = "steam-ws",      match = { class = "steam" },                      workspace = "2" })
hl.window_rule({ name = "steam-tile",    match = { class = "steam" },                      float = false })
hl.window_rule({ name = "beatoraja-cfg", match = { class = "beatoraja 0.8.8 configuration" }, workspace = "2" })
hl.window_rule({ name = "wuwa-ws",       match = { title = "鳴潮" },                        workspace = "7" })
hl.window_rule({ name = "obs-ws",        match = { class = "com.obsproject.Studio" },      workspace = "10" })
hl.window_rule({ name = "ds-ws",         match = { title = "DEATH STRANDING DIRECTOR'S CUT" }, workspace = "7" })
hl.window_rule({ name = "ds-fs",         match = { title = "DEATH STRANDING DIRECTOR'S CUT" }, fullscreen = true })

hl.window_rule({ name = "osu-fs",        match = { class = "osu!" },                       fullscreen = true })
hl.window_rule({ name = "bluearchive",   match = { title = "ブルーアーカイブ" },             float = true })
hl.window_rule({ name = "kitty-opacity", match = { class = "kitty" },                      opacity = "0.9 0.7 0.85" })

-- workspace → monitor assignments
hl.workspace_rule({ workspace = "1",  monitor = "DP-2" })
hl.workspace_rule({ workspace = "2",  monitor = "DP-3" })
hl.workspace_rule({ workspace = "3",  monitor = "HDMI-A-3" })
hl.workspace_rule({ workspace = "7",  monitor = "DP-3" })
hl.workspace_rule({ workspace = "8",  monitor = "DP-2" })
hl.workspace_rule({ workspace = "10", monitor = "HDMI-A-3" })
