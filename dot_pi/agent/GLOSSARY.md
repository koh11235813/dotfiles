# Pi agent extensions

Pi に足している拡張 (guard、checkpoint、verify、compactjev、subagent) と、agmsg との接続で使う言葉。

## Language

### agmsg との接続

**Notify**:
何かが起きたという事実だけをモデルに伝えるもの。中身 (本文や出力) は運ばない。
_Avoid_: 通知、知らせ、イベント

**Message**:
agmsg でエージェントが別のエージェントに宛てて送った本文。
_Avoid_: メール、通知

**Delivery**:
Message の本文をモデルに届けること。未読があると伝えるだけの Notify は Delivery ではない。
_Avoid_: 配信、通知、受信
