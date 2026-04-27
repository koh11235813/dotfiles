" --- 1. パフォーマンスと基本設定の改善 ---

" スワップファイル、バックアップファイル、アンドゥファイルの保存先を一箇所に集約
" Arch Linuxのホームディレクトリに.vimディレクトリがあることを前提とします
set backupdir=~/.vim/backup
set directory=~/.vim/swap
set undodir=~/.vim/undo
" ファイルが存在しない場合は自動で作成
silent !mkdir -p ~/.vim/backup ~/.vim/swap ~/.vim/undo

" 検索時の設定 (既存設定の強化)
set ignorecase          " 検索時に大文字/小文字を区別しない
set smartcase           " 検索パターンに大文字が含まれる場合のみ、大文字/小文字を区別する
set incsearch           " 入力中に検索結果をリアルタイムで表示
set hlsearch            " 検索結果をハイライト

" ファイルを閉じるのではなく、バッファとして非表示にして保持 (quick-switchに便利)
set hidden

" 画面の再描画を遅延させることで高速化 (大きなファイルを開く際などに有効)
set lazyredraw

" タブ補完をBashのようにする
set wildmode=list:longest,full
set completeopt=menu,menuone,noselect

"let s:MINIMUM_COMPLETE_LENGTH = 3
"
"function! s:auto_cmp_start() abort
"    if pumvisible()
"        return
"    endif
"
"    let prev_str = (slice(getline('.'), 0, charcol('.')-1) .. v:char)
"                \ -> substitute(',*[^[:keyword:]]', '', '')
"
"    if strchars(prev_str) < s:MINIMUM_COMPLETE_LENGTH
"        return
"    endif
"
"    call feedkeys("\<c-n>", 'ni')
"endfunction
"
"augroup auto_cmp_start
"    autocmd!
"    autocmd InsertCharPre * call s:auto_cmp_start()
"augroup END
"

" --- 2. コーディング効率の向上 (インデントと表示) ---

" Tab/インデントの設定 (スペース4が一般的)
set tabstop=4           " Tab文字の表示幅
set shiftwidth=4        " 自動インデントの幅
set expandtab           " Tabキーでスペースを挿入する

" 自動インデント・スマートインデントを有効化
set autoindent
set smartindent

" 行番号の設定 (ナビゲーション強化)
set number              " 絶対行番号を表示
set relativenumber      " 相対行番号を表示 (ノーマルモードでの移動に便利)
augroup numbertoggle
  autocmd!
  autocmd BufEnter,FocusGained,InsertLeave * set relativenumber
  autocmd BufLeave,FocusLost,InsertEnter   * set norelativenumber
augroup END

" カーソル下の文字をハイライト (視認性向上)
" set cursorline

" ステータスラインの設定
set laststatus=2        " 常にステータスラインを表示

" ファイル保存時に行末の不要な空白を自動で削除
autocmd BufWritePre * %s/\s\+$//e

" --- 3. プラグイン管理 (vim-plug) ---
call plug#begin('~/.vim/plugged')

  " ステータスラインの強化 (見た目も美しく、開発情報を表示)
  Plug 'vim-airline/vim-airline'
  Plug 'vim-airline/vim-airline-themes'

  " ファイルツリー (NERDTreeは古い、後継の**nvim-tree**などがよりモダンですが、Vim互換なら以下)
  Plug 'scrooloose/nerdtree'

  " 括弧の対応をハイライト (可読性向上)
  Plug 'luochen1990/rainbow'

  " 閉じタグ/括弧の自動補完
  Plug 'jiangmiao/auto-pairs'

  " 構文チェック/Linter (Arch Linuxでよく使われる静的解析ツールと連携)
  Plug 'dense-analysis/ale'

  Plug 'cocopon/iceberg.vim'

  " python環境
  Plug 'davidhalter/jedi-vim'

  " rust環境
  Plug 'rust-lang/rust.vim'
  Plug 'neoclide/coc.nvim', {'branch': 'release'}

call plug#end()

syntax enable
filetype plugin indent on

" rust auto format
let g:rustfmt_autosave = 1

" Having longer updatetime (default is 4000 ms = 4 s) leads to noticeable
" delays and poor user experience.
set updatetime=300

" Always show the signcolumn, otherwise it would shift the text each time
" diagnostics appear/become resolved.
if has("patch-8.1.1564")
  " Recently vim can merge signcolumn and number column into one
  set signcolumn=number
else
  set signcolumn=yes
endif


" Make <CR> auto-select the first completion item and notify coc.nvim to
" format on enter, <cr> could be remapped by other vim plugin
inoremap <silent><expr> <cr> pumvisible() ? coc#_select_confirm()
                              \: "\<C-g>u\<CR>\<c-r>=coc#on_enter()\<CR>"

" GoTo code navigation.
nmap <silent> gd <Plug>(coc-definition)
nmap <silent> gy <Plug>(coc-type-definition)
nmap <silent> gi <Plug>(coc-implementation)
nmap <silent> gr <Plug>(coc-references)

" プラグイン設定例
let g:airline_theme='molokai' " お好みのテーマに
let g:rainbow_active = 1

" 256色またはTrueColorを有効化（Hyprlandやターミナルエミュレータが対応している場合）
set termguicolors
colorscheme iceberg
set background=dark
