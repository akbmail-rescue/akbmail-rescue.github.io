#!/usr/bin/env python3
"""AKB48 Mail 画面収録 → メール単位の画像に自動分割するプロトタイプ.

方式:
  1. ffmpegで6fpsフレーム抽出(フル解像度)
  2. 各フレームを分類: list / loading / detail / fullscreen_image
     - 本文領域の非白ピクセル率 + 背景の暗さで判定
  3. loading(真っ白な本文)イベントを境界に「1メールの閲覧区間」へセグメント化
  4. 区間内で最も情報量が多く安定したdetailフレームを代表として採用
  5. ヘッダーのタイムスタンプをOCRしてファイル名に採用
  6. ステータスバーと録画インジケータを除去して保存
"""
import glob, os, re, shutil, subprocess, sys
from PIL import Image
import imagehash
import pytesseract

SRC = sys.argv[1]
WORK = "/home/claude/akbmail/work"
OUT = "/home/claude/akbmail/out"
FPS = 6

def extract_frames():
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK)
    subprocess.run(["ffmpeg", "-v", "error", "-i", SRC,
                    "-vf", f"fps={FPS}", f"{WORK}/f_%05d.png"], check=True)

def body_metric(img_l, w, h):
    body = img_l.crop((0, int(h*0.28), w, int(h*0.90)))
    px = body.tobytes()
    return sum(1 for p in px if p < 240) / len(px)

def darkness(img_l, w, h):
    """フルスクリーン画像ビューアは背景が暗色 (上下端で判定)"""
    top = img_l.crop((0, int(h*0.10), w, int(h*0.16))).tobytes()
    bot = img_l.crop((0, int(h*0.92), w, int(h*0.98))).tobytes()
    px = top + bot
    return sum(1 for p in px if p < 60) / len(px)

def header_metric(img_rgb, w, h):
    """メール詳細ヘッダーの有無: アバター領域(x 0.06-0.15, y 0.145-0.19)の彩度画素率.
    彩度画素 = HSV の S > 0.2 と同値の整数判定 (max-min)*5 > max (max=0 は非該当)."""
    crop = img_rgb.crop((int(w*0.06), int(h*0.145), int(w*0.15), int(h*0.19)))
    px = crop.tobytes()
    n = len(px) // 3
    sat = 0
    for i in range(0, len(px), 3):
        r, g, b = px[i], px[i+1], px[i+2]
        mx = max(r, g, b); mn = min(r, g, b)
        if (mx - mn) * 5 > mx:
            sat += 1
    return sat / n

def ocr_timestamp(img):
    w, h = img.size
    crop = img.crop((int(w*0.55), int(h*0.13), w, int(h*0.18))).convert("L")
    crop = crop.resize((crop.width*2, crop.height*2))
    txt = pytesseract.image_to_string(
        crop, config="--psm 7 -c tessedit_char_whitelist=0123456789-: ")
    m = re.search(r"(20\d\d)-(\d\d)-(\d\d)\s*(\d\d):?(\d\d)", txt)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}_{m.group(4)}{m.group(5)}"
    return None

def classify(path):
    img = Image.open(path)
    w, h = img.size
    g = img.convert("L")
    bm = body_metric(g, w, h)
    dk = darkness(g, w, h)
    hd = header_metric(img.convert("RGB"), w, h)
    if dk > 0.5:
        cat = "fullscreen"
    elif bm < 0.02:
        cat = "loading"
    elif bm < 0.15:
        cat = "list"
    else:
        cat = "detail"
    # 境界シグナル: 本文ブランク(loading) かつ ヘッダー有り(彩度画素率 > 0.15)
    return {"path": path, "img": img, "bm": bm, "hd": hd, "cat": cat,
            "boundary": cat == "loading" and hd > 0.15,
            "hash": imagehash.phash(g.resize((256, 256)))}

def main():
    extract_frames()
    frames = [classify(p) for p in sorted(glob.glob(f"{WORK}/f_*.png"))]

    # 境界イベント(loading かつ ヘッダー有り)の立ち上がりで区間分割。
    # ヘッダー無しの loading フレーム(遷移途中)は境界にも区間にも含めない
    segments, cur = [], []
    prev_boundary = False
    for fr in frames:
        if fr["boundary"] and not prev_boundary:
            if cur:
                segments.append(cur)
            cur = []
        elif fr["cat"] != "loading":
            cur.append(fr)
        prev_boundary = fr["boundary"]
    if cur:
        segments.append(cur)

    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    saved_mail, saved_img, seen_hashes = 0, 0, []

    def is_dup(h):
        return any(h - s <= 6 for s in seen_hashes)

    for seg in segments:
        details = [f for f in seg if f["cat"] == "detail"]
        if details:
            # 安定した(前フレームと同一の)フレームのうち情報量最大を代表に
            stable = [details[i] for i in range(1, len(details))
                      if details[i]["hash"] - details[i-1]["hash"] <= 2]
            best = max(stable or details, key=lambda f: f["bm"])
            if not is_dup(best["hash"]):
                seen_hashes.append(best["hash"])
                ts = None
                for f in details:
                    ts = ocr_timestamp(f["img"])
                    if ts:
                        break
                saved_mail += 1
                name = f"mail_{ts or 'unknown_%02d' % saved_mail}.png"
                w, h = best["img"].size
                best["img"].crop((0, int(h*0.055), w, h)).save(f"{OUT}/{name}")
        # フルスクリーン画像も安定フレームを保存
        fulls = [f for f in seg if f["cat"] == "fullscreen"]
        for i in range(1, len(fulls)):
            if fulls[i]["hash"] - fulls[i-1]["hash"] <= 2 and not is_dup(fulls[i]["hash"]):
                seen_hashes.append(fulls[i]["hash"])
                saved_img += 1
                img = fulls[i]["img"]
                w, h = img.size
                img.crop((0, int(h*0.055), w, h)).save(f"{OUT}/image_{saved_img:03d}.png")

    print(f"segments={len(segments)} mails={saved_mail} images={saved_img}")
    for f in sorted(os.listdir(OUT)):
        print(" ", f)

if __name__ == "__main__":
    main()
