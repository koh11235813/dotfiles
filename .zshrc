# License : MIT
# http://mollifier.mit-license.org/

########################################
# 環境変数
# export LANG=ja_JP.UTF-8
export LANG=en_US.UTF-8

# 色を使用出来るようにする
autoload -Uz colors
colors

# emacs 風キーバインドにする
# bindkey -e

# ヒストリの設定
HISTFILE=~/.zsh_history
HISTSIZE=1000000
SAVEHIST=1000000

# 改変箇所_1
# 時間表記の追加
setopt extended_history
alias history='history -t "%F %T"'

# 改変箇所_3
# 出力の後に改行を入れる
function add_line {
  if [[ -z "${PS1_NEWLINE_LOGIN}" ]];
then
    PS1_NEWLINE_LOGIN=true
  else
    printf '\n'
  fi
}
# PROMPT_COMMAND='add_line'
# precmd_functions+=(add_line)

# 単語の区切り文字を指定する
autoload -Uz select-word-style
select-word-style default

# ここで指定した文字は単語区切りとみなされる
# / も区切りと扱うので、^W でディレクトリ１つ分を削除できる
zstyle ':zle:*' word-chars " /=;@:{},|"
zstyle ':zle:*' word-style unspecified

########################################
#==========vcs_info=====================
autoload -Uz vcs_info

setopt prompt_subst
zstyle ':vcs_info:git:*' check-for-changes true
zstyle ':vcs_info:git:*' stagedstr "%F{yellow}●"
zstyle ':vcs_info:git:*' unstagedstr "%F{red}+"
zstyle ':vcs_info:*' formats "%F{cyan}[%b%c%u]%f"
zstyle ':vcs_info:*' actionformats "%F{cyan}[%b|%a]%f"

# prompt
# 1 liner
# PROMPT='%h %B%F{214}%W%f%b,%B%F{86}%*%f%b:%B%F{20}%~%f%b $ '
PROMPT='%h %F{86}%n@%m%f:%F{blue}%~%f%b $ '

# 2 lines
# PROMPT="%{${fg[green]}%}[%n@%m]%{${reset_color}%} %~
# %# "

precmd() { vcs_info }
# precmd_functions+=(vcs_info)
RPROMPT='${vcs_info_msg_0_}'

########################################
# オプション
# 日本語ファイル名を表示可能にする
setopt print_eight_bit

# beep を無効にする
# setopt no_beep

# フローコントロールを無効にする
setopt no_flow_control

# Ctrl+Dでzshを終了しない
# setopt ignore_eof

# '#' 以降をコメントとして扱う
# setopt interactive_comments

# ディレクトリ名だけでcdする
setopt auto_cd

# cd したら自動的にpushdする
setopt auto_pushd
# 重複したディレクトリを追加しない
setopt pushd_ignore_dups

# 同時に起動したzshの間でヒストリを共有する
setopt share_history

# 同じコマンドをヒストリに残さない
setopt hist_ignore_all_dups

# スペースから始まるコマンド行はヒストリに残さない
# setopt hist_ignore_space

# ヒストリに保存するときに余分なスペースを削除する
setopt hist_reduce_blanks

# 高機能なワイルドカード展開を使用する
setopt extended_glob

########################################
# キーバインド

# ^R で履歴検索をするときに * でワイルドカードを使用出来るようにする
bindkey '^R' history-incremental-pattern-search-backward

########################################
# エイリアス
alias ls='ls -G'
alias la='ls -a'
alias ll='ls -la'
alias l='ls -l'

alias rm='rm -i'
alias cp='cp -i'
alias mv='mv -i'

alias mkdir='mkdir -p'

# sudo の後のコマンドでエイリアスを有効にする
alias sudo='sudo '

# グローバルエイリアス
alias -g L='| less'
alias -g G='| grep'

# C で標準出力をクリップボードにコピーする
# Mac用のみ残し、他OS向けはコメントアウト
if which pbcopy >/dev/null 2>&1 ; then
    # Mac
    alias -g C='| pbcopy'
elif which xsel >/dev/null 2>&1 ; then
     # Linux
     alias -g C='| xsel --input --clipboard'
elif which putclip >/dev/null 2>&1 ; then
     # Cygwin
     alias -g C='| putclip'
fi

########################################
# OS 別の設定
case ${OSTYPE} in
    darwin*)
        #Mac用の設定
        export CLICOLOR=1
        export PATH=/Library/Apple/usr/bin:$PATH
        alias ls='ls -G -F'
        #======================================
        # Docker (colima)
        # =====================================
        docker() {
            if ! colima status 2>/dev/null | grep -q "Running"; then
                echo "[colima] starting..."
                colima start --vm-type vz --arch aarch64 --cpu 6 --memory 12 --disk 100 >/dev/null
            fi
            command docker "$@"
        }

        # Homebrew
        export PATH="/opt/homebrew/bin:$PATH"
        ;;
    linux*)
            #Linux用の設定
            alias ls='ls -F --color=auto'
            ;;
esac

#======================================
# Docker (colima)
# =====================================
# docker() {
#     if ! colima status 2>/dev/null | grep -q "Running"; then
#         echo "[colima] starting..."
#         colima start --vm-type vz --arch aarch64 --cpu 6 --memory 12 --disk 100 >/dev/null
#     fi
#     command docker "$@"
# }

#======================================
# export
#======================================
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/sbin:$PATH
export PATH=/usr/local/bin:$PATH

#======================================
# alias
#======================================
alias ll='ls -la'
alias python='python3'
alias pip='pip3'
alias mkdir='mkdir -p'

#======================================
# function
#======================================
eval "$(/usr/libexec/path_helper)"

wttr(){
        curl -H "Accept-Language: ${LANG%_*}" wttr.in/"${1:-ichinomiya}"
}

function delkasu () { find $1 \( -name '.DS_Store' -o -name '._*' -o -name '.apdisk' -o -name 'Thumbs.db' -o -name 'Desktop.ini' \) -delete -print;
}

# Rust (cargo)
. "$HOME/.cargo/env"


########################################
# 補完
# 補完機能を有効にする
autoload -Uz compinit
compinit

# 補完で小文字でも大文字にマッチさせる
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Z}'

# ../ の後は今いるディレクトリを補完しない
zstyle ':completion:*' ignore-parents parent pwd ..

# sudo の後ろでコマンド名を補完する
zstyle ':completion:*:sudo:*' command-path /usr/local/sbin /usr/local/bin \
                   /usr/sbin /usr/bin /sbin /bin /usr/X11R6/bin

# ps コマンドのプロセス名補完
zstyle ':completion:*:processes' command 'ps x -o pid,s,args'

# Added by LM Studio CLI (lms)
export PATH="$PATH:$HOME.lmstudio/bin"
# End of LM Studio CLI section


# Added by Antigravity
export PATH="$HOME/.antigravity/antigravity/bin:$PATH"

# proto
export PROTO_HOME="$HOME/.proto";
export PATH="$PROTO_HOME/shims:$PROTO_HOME/bin:$PATH";

# uv
export UV_SKIP_WHEEL_FILENAME_CHECK=1

# zsh-autosuggestions
if [ -f "/opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh" ]; then
    source "/opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
elif [ -f "/usr/local/share/zsh-autosuggestions/zsh-autosuggestions.zsh" ]; then
    source "/usr/local/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
fi

# zsh-syntax-highlighting
if [ -f "/opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh" ]; then
    source "/opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
elif [ -f "/usr/local/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh" ]; then
    source "/usr/local/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
fi

