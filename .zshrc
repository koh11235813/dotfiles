# ~/.zshrc
export EDITOR=vim
# exit when not interactive shell
[[ $- != *i* ]] && return

# Ignore duplicate history, Specify history length
setopt hist_ignore_all_dups
HISTFILE=~/.zsh_history
HISTSIZE=10000
SAVEHIST=20000
setopt append_history       # Append to history file
setopt share_history        # Share history with other terminals

# prompt settings (color)
autoload -Uz colors && colors
PROMPT='%h %F{green}%n@%m%f:%F{blue}%~%f %# '
RPROMPT=''

# refresh window size
# unsetopt CHECKWINSIZE

# less settings (compativility bash)
if [[ -x /usr/bin/lesspipe ]]; then
  eval "$(SHELL=/bin/sh lesspipe)"
fi

# LANG settings on Linux
[[ "$TERM" == "linux" ]] && export LANG=C.UTF-8

# ls, grep
if [[ -x /usr/bin/dircolors ]]; then
  if [[ -r ~/.dircolors ]]; then
    eval "$(dircolors -b ~/.dircolors)"
  else
    eval "$(dircolors -b)"
  fi
fi

alias ls='ls --color=auto'
alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'
alias mkdir='mkdir -p'

# ls
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'

# too long time notify
alias alert='notify-send --urgency=low -i "$([ $? = 0 ] && echo terminal || echo error)" "$(history 1 | sed "s/^[ ]*[0-9]\+[ ]*//;s/[;&|]\s*alert$//")"'

# ~/.zsh_aliases
if [[ -f ~/.zsh_aliases ]]; then
  source ~/.zsh_aliases
fi

# /usr/local/etc/alias.d/*.sh
if [[ -d /usr/local/etc/alias.d/ ]]; then
  for i in /usr/local/etc/alias.d/*.sh; do
    if [[ -r $i ]]; then
      source "$i" >/dev/null 2>&1
    fi
  done
  unset i
fi

# Git, vcs_info
# === vcs_info ===
autoload -Uz vcs_info
precmd() { vcs_info }

setopt prompt_subst
zstyle ':vcs_info:git:*' check-for-changes true
zstyle ':vcs_info:git:*' stagedstr "%F{yellow}●"
zstyle ':vcs_info:git:*' unstagedstr "%F{red}+"
zstyle ':vcs_info:*' formats "%F{cyan}[%b%c%u]%f"
zstyle ':vcs_info:*' actionformats "%F{cyan}[%b|%a]%f"
RPROMPT='${vcs_info_msg_0_}'

# === zle ===
autoload -Uz history-search-end
zle -N history-beginning-search-backward-end history-search-end
zle -N history-beginning-search-forward-end history-search-end
bindkey "^p" history-beginning-search-backward-end
bindkey "^n" history-beginning-search-forward-end

bindkey "^r" history-incremental-search-backward
bindkey "^s" history-incremental-search-forward

# Ctrl+A, Ctrl+E
bindkey '^A' beginning-of-line
bindkey '^E' end-of-line
bindkey '^K' kill-line
bindkey '^U' backward-kill-line

# cargo & rustc

# === pyenv ===
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"

# === ruby ===
export GEM_HOME="$(gem env user_gemhome)"
export GEM_PATH="$GEM_HOME:$GEM_PATH"
export PATH="$PATH:$GEM_HOME/bin"

# === npm ===
export PATH="$HOME/.local/share/npm/bin:$PATH"

# === nvm ===
source /usr/share/nvm/init-nvm.sh

# enable complite
fpath=(~/.zsh/plugins/zsh-completions/src $fpath)
autoload -Uz compinit
compinit
autoload -Uz colors
colors
# Match uppercase and lowercase
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Z}'

# ../ Do not complete the current directory
zstyle ':completion:*' ignore-parents parent pwd ..

# Complete after sudo
zstyle ':completion:*:sudo:*' command-path /usr/local/sbin /usr/local/bin \
                   /usr/sbin /usr/bin /sbin /bin
# process complite with ps
zstyle ':completion:*:processes' command 'ps x -o pid,s,args'

# set divide words
autoload -Uz select-word-style
select-word-style default
zstyle ':zle:*' word-chars " /=;@:{},|"
zstyle ':zle:*' word-style unspecified

# Added by LM Studio CLI (lms)
export PATH="$PATH:/home/kinoko/.lmstudio/bin"
# End of LM Studio CLI section

# proto
export PROTO_HOME="$HOME/.proto";
export PATH="$PROTO_HOME/shims:$PROTO_HOME/bin:$PATH";

# fpath+=${ZSH_CUSTOM:-${ZSH:-~/.zsh}}/plugins/zsh-completions/src
# source "$ZSH/.zsh/"
function add_line {
  if [[ -z "${PS1_NEWLINE_LOGIN}" ]]; then
    PS1_NEWLINE_LOGIN=true
  else
    printf '\n'
  fi
}
#PROMPT_COMMAND='add_line'
precmd_functions+=(add_line)
export UV_SKIP_WHEEL_FILENAME_CHECK=1

# export env
. ~/.env
export PATH="$HOME/.local/bin:$PATH"

source ~/.zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
source ~/.zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh


