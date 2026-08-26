#!/usr/bin/env python3
"""実アプリのレイアウトを模した長文メールを合成し、iOS風スクロール動画を生成する.

出力:
  synth/ground_truth.png : 完全な縦長メール画像(正解データ)
  synth/scroll.mp4       : フリック+慣性+静止を模したスクロール録画
"""
import math, os, random, subprocess, shutil
from PIL import Image, ImageDraw, ImageFont

W, H = 1290, 2796            # iPhone 15 Pro Max
STATUS_H = 154               # ステータスバー領域(実測 h*0.055)
random.seed(42)

FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
f_body = ImageFont.truetype(FONT, 44)
f_name = ImageFont.truetype(FONT, 46)
f_date = ImageFont.truetype(FONT, 40)
f_subj = ImageFont.truetype(FONT, 48)

BODY_LINES = []
paras = [
    "今日はリハーサルが長くて、終わったらもう夜だったよ〜",
    "お昼はケータリングのカレーを食べました！おかわりしちゃった",
    "最近ハマってるドラマの話をメンバーとずっとしてた(笑)",
    "明日は握手会だね！みんなに会えるのたのしみすぎる〜",
    "新しい衣装がとってもかわいいの。早く見せたいな",
    "レッスンで新曲のフォーメーション覚えるの大変だったけど頑張った！",
    "帰りにコンビニで新作のスイーツ買っちゃった。ご褒美ってことで！",
    "お風呂にゆっくり入って今日の疲れをリセットします",
    "そういえば昨日のブログ読んでくれた？感想まってるね",
    "来週の公演にむけてボイトレも気合いれていくよ〜",
    "ファンのみんなの応援がほんとに力になってます。いつもありがとう",
    "おやすみなさい！また明日もメールするね",
]
for p in paras:
    # 44px 25文字前後で折り返し
    while len(p) > 25:
        BODY_LINES.append(p[:25]); p = p[25:]
    BODY_LINES.append(p)
    BODY_LINES.append("")            # 段落間の空行
    if random.random() < 0.3:
        BODY_LINES.append("")

def build_ground_truth():
    line_h = 66
    body_h = len(BODY_LINES) * line_h + 200
    img_block = 1200                 # インライン画像
    total = 560 + body_h + img_block + 400
    img = Image.new("RGB", (W, total), "white")
    d = ImageDraw.Draw(img)
    # 戻るボタン行
    d.line((60, 120, 90, 150), fill=(180,180,180), width=8)
    d.line((60, 120, 90, 90), fill=(180,180,180), width=8)
    d.line((0, 190, W, 190), fill=(230,230,230), width=2)
    # 送信者ヘッダー
    d.ellipse((50, 230, 190, 370), fill=(240,200,210))
    d.text((220, 250), "推田 めるる", font=f_name, fill=(30,30,30))
    d.text((220, 320), "To: mm", font=f_date, fill=(130,130,130))
    d.text((W-560, 255), "2026-08-25 21:30", font=f_date, fill=(130,130,130))
    d.line((0, 420, W, 420), fill=(230,230,230), width=2)
    # 件名バー
    d.text((50, 460), "きょうのできごと", font=f_subj, fill=(30,30,30))
    d.line((0, 560, W, 560), fill=(230,230,230), width=2)
    # 本文
    y = 660
    for ln in BODY_LINES:
        if ln:
            d.text((50, y), ln, font=f_body, fill=(40,40,40))
        y += line_h
    # インライン画像(グラデーション矩形で代用)
    y += 60
    for i in range(img_block):
        c = (255 - i//8, 150 + i//14, 180)
        d.line((45, y+i, W-45, y+i), fill=c)
    d.text((420, y + img_block//2 - 40), "(添付画像イメージ)", font=f_subj, fill=(255,255,255))
    os.makedirs("synth", exist_ok=True)
    img.save("synth/ground_truth.png")
    return img

def ease_out(t):
    return 1 - (1 - t) ** 3

def render_scroll(gt):
    shutil.rmtree("synth/sf", ignore_errors=True)
    os.makedirs("synth/sf")
    total = gt.height
    max_off = total - (H - STATUS_H)
    fps = 30
    frames = []
    off = 0.0
    # 「静止→フリック→慣性減速」を繰り返すiOS風パターン
    while off < max_off - 1:
        for _ in range(int(fps * random.uniform(0.7, 1.3))):   # 静止(読む)
            frames.append(off)
        dist = random.uniform(900, 1500)                       # フリック1回分
        dur = int(fps * random.uniform(0.5, 0.8))
        start = off
        for i in range(dur):
            off = min(max_off, start + dist * ease_out((i+1)/dur))
            frames.append(off)
    for _ in range(fps):
        frames.append(max_off)
    status = Image.new("RGB", (W, STATUS_H), (250, 250, 250))
    sd = ImageDraw.Draw(status)
    sd.text((100, 45), "8:31", font=f_name, fill=(20,20,20))
    sd.rounded_rectangle((380, 30, 900, 120), radius=60, fill=(15,15,15))
    sd.ellipse((420, 55, 460, 95), fill=(230,60,50))
    for i, o in enumerate(frames):
        fr = Image.new("RGB", (W, H), "white")
        fr.paste(gt.crop((0, int(o), W, int(o) + H - STATUS_H)), (0, STATUS_H))
        fr.paste(status, (0, 0))
        fr.save(f"synth/sf/s_{i:05d}.png")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-framerate", str(fps),
                    "-i", "synth/sf/s_%05d.png", "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", "synth/scroll.mp4"], check=True)
    print(f"ground_truth: {W}x{total}px, video frames: {len(frames)} ({len(frames)/fps:.1f}s)")

if __name__ == "__main__":
    os.chdir("/home/claude/akbmail")
    gt = build_ground_truth()
    render_scroll(gt)
