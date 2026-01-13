" An example for a vimrc file.
"
" Maintainer:	The Vim Project <https://github.com/vim/vim>
" Last Change:	2023 Aug 10
" Former Maintainer:	Bram Moolenaar <Bram@vim.org>
"
" To use it, copy it to
"	       for Unix:  ~/.vimrc
"	      for Amiga:  s:.vimrc
"	 for MS-Windows:  $VIM\_vimrc
"	      for Haiku:  ~/config/settings/vim/vimrc
"	    for OpenVMS:  sys$login:.vimrc

" When started as "evim", evim.vim will already have done these settings, bail
" out.
"
if v:progname =~? "evim"
  finish
endif

" syntax on
if has("syntax")
  syntax on
endif

set number

" 相対行番号の表示 (カーソルから上下の行数) - ナビゲーションに便利
" set numberと併用し、ノーマルモードでrelativenumber、インサートモードでnumberにする設定も人気
set relativenumber
augroup numbertoggle
  autocmd!
  autocmd BufEnter,FocusGained,InsertLeave * set relativenumber
  autocmd BufLeave,FocusLost,InsertEnter   * set norelativenumber
augroup END

" Save fold settings
" autocmd BufWritePost if expand('%') != '' && & buftype !~ 'nofile' | mkview | endif
" autocmd BufRead if expand('%') != '' && &buftype !~ 'nofile' | silent loadview | endif
augroup PersistentFolds
    autocmd!
    autocmd BufWritePost,BufWinLeave *
                \ if expand('%:p') !=# '' && &buftype ==# '' | silent! mkview | endif
    autocmd BufWinEnter *
                \ if expand('%:p') !=# '' && &buftype ==# '' | silent! loadview | endif
augroup END
" Don't Save options
set viewoptions -=options

set viewdir=~/.vim/view//
set directory=~/.vim/dir//
set backupdir=~/.vim/back//
set undodir=~/.vim/undo//

set hidden
set showcmd
set laststatus=2
" set termguicolors
" set tab width 4
set tabstop=4

" auto indent width
set shiftwidth=4

" space instead tab
set expandtab

autocmd BufWritePre * %s/\s\+$//e

" keep indent
set autoindent
set smartindent

filetype plugin indent on
" autocmd FileType python setlocal tabstop=4 shiftwidth=4 expandtab

hi Comment ctermfg=3

set clipboard=unnamed,autoselect

" Get the defaults that most users want.
source $VIMRUNTIME/defaults.vim

if has("vms")
  set nobackup		" do not keep a backup file, use versions instead
else
  set backup		" keep a backup file (restore to previous version)
  if has('persistent_undo')
    set undofile	" keep an undo file (undo changes after closing)
  endif
endif

if &t_Co > 2 || has("gui_running")
  " Switch on highlighting the last used search pattern.
  set hlsearch
endif

" Put these in an autocmd group, so that we can delete them easily.
augroup vimrcEx
  au!

" For all text files set 'textwidth' to 78 characters.
autocmd FileType text setlocal textwidth=78
augroup END

" Add optional packages.
"
" The matchit plugin makes the % command work better, but it is not backwards
" compatible.
" The ! means the package won't be loaded right away but when plugins are
" loaded during initialization.
if has('syntax') && has('eval')
    packadd! matchit
endif

call plug#begin()
    Plug 'vim-airline/vim-airline'
    Plug 'luochen1990/rainbow'
    Plug 'cocopon/iceberg.vim'
    Plug 'lervag/vimtex'
call plug#end()
set termguicolors
colorscheme iceberg
set background=dark
