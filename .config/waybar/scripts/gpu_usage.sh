#!/bin/bash

# radeontopの出力から "gpu X.XX%" の X.XX を抜き出す
usage=$(radeontop -d - -l 1 | grep -oP 'gpu \K[0-9.]+(?=%)')

# 使用率が取得できなかった場合のフォールバック
if [[ -z "$usage" ]]; then
  usage="N/A"
fi

echo "gpu: ${usage}%"
