#!/usr/bin/env python3
"""スクロール動画 → 1枚の縦長メール画像に再構成するスティッチャー.

方式: 連続フレーム間の縦方向移動量を位相相関(cv2.phaseCorrelate)で推定し、
2026-08-26: 相関は 1/2 縮小(INTER_AREA、偶数サイズに切詰め)で行い dx/dy を原寸換算。応答が [0.55, 0.85) の曖昧な対は原寸で再判定。
新たに現れた下端領域だけをキャンバスに継ぎ足していく。
使い方: python3 stitch.py <video> <out.png> [fixed_top_px]
"""
import subprocess, sys, glob, os, shutil
import cv2
import numpy as np

def extract(video, workdir, fps=6):
    shutil.rmtree(workdir, ignore_errors=True)
    os.makedirs(workdir)
    subprocess.run(["ffmpeg", "-v", "error", "-i", video,
                    "-vf", f"fps={fps}", f"{workdir}/t_%05d.png"], check=True)
    return sorted(glob.glob(f"{workdir}/t_*.png"))

CORR_SCALE = 2
RECHECK_BAND = (0.55, 0.85)

def corr_gray(im, scale):
    g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    if scale != 1:
        h, w = g.shape
        g = cv2.resize(g[:h // scale * scale, :w // scale * scale], (w // scale, h // scale), interpolation=cv2.INTER_AREA)
    return g.astype(np.float64)

def stitch(video, out_png, fixed_top=154, fps=6, scale=CORR_SCALE, recheck=True):
    files = extract(video, "/home/claude/akbmail/stitch_work", fps)
    imgs = []
    for f in files:
        im = cv2.imread(f)
        imgs.append(im[fixed_top:, :, :])          # 固定ヘッダー除去
    h, w = imgs[0].shape[:2]

    canvas = imgs[0].copy()
    y_bottom = h                                    # キャンバス上の現在の下端
    prev_g = corr_gray(imgs[0], scale)
    hann = cv2.createHanningWindow((prev_g.shape[1], prev_g.shape[0]), cv2.CV_64F)
    hann_full = cv2.createHanningWindow((w, h), cv2.CV_64F)
    prev_full = imgs[0]

    for im in imgs[1:]:
        g = corr_gray(im, scale)
        (dx, dy), resp = cv2.phaseCorrelate(prev_g, g, hann)
        dx *= scale; dy *= scale
        if scale != 1 and recheck and RECHECK_BAND[0] <= resp < RECHECK_BAND[1]:
            (dx, dy), resp = cv2.phaseCorrelate(corr_gray(prev_full, 1), corr_gray(im, 1), hann_full)
        prev_g = g
        prev_full = im
        dy = -dy                                    # 下スクロール = コンテンツは上へ移動
        if resp < 0.7 or abs(dx) > 12:
            continue                                # 相関が弱い/横ズレ = 画面遷移等は無視(2026-08-26: ページ切替アニメ resp≈0.59 を除くため 0.05→0.7)
        if dy < 2:
            continue                                # 静止フレーム
        dy = int(round(dy))
        new_part = im[h - dy:, :, :] if dy < h else im
        add_h = new_part.shape[0]
        grown = np.full((y_bottom + add_h, w, 3), 255, dtype=np.uint8)
        grown[:y_bottom] = canvas
        grown[y_bottom:] = new_part
        # 2026-08-26: 以前は直前フレーム全体で上書きしていたが、実アプリの collapsing header
        # (本文と別速度で縮むヘッダー)が二重描画されるため、新規行だけを継ぎ足す
        canvas = grown
        y_bottom += add_h

    cv2.imwrite(out_png, canvas)
    print(f"stitched: {canvas.shape[1]}x{canvas.shape[0]}px from {len(imgs)} frames")
    return canvas

def validate(canvas, gt_path, fixed_top=154):
    gt = cv2.imread(gt_path)
    print(f"ground truth: {gt.shape[1]}x{gt.shape[0]}px")
    dh = abs(gt.shape[0] - canvas.shape[0])
    print(f"height diff: {dh}px ({dh/gt.shape[0]*100:.1f}%)")
    # 正解画像内の複数バンドがスティッチ結果に存在するか照合
    hit = 0; bands = 8
    for i in range(bands):
        y = int(gt.shape[0] * (i + 0.5) / bands)
        tpl = cv2.cvtColor(gt[y:y+120, 100:-100], cv2.COLOR_BGR2GRAY)
        res = cv2.matchTemplate(cv2.cvtColor(canvas, cv2.COLOR_BGR2GRAY), tpl, cv2.TM_CCOEFF_NORMED)
        score = res.max()
        hit += score > 0.9
        print(f"  band {i+1}/{bands} @y={y}: match={score:.3f}")
    print(f"bands recovered: {hit}/{bands}")

if __name__ == "__main__":
    video = sys.argv[1] if len(sys.argv) > 1 else "synth/scroll.mp4"
    out = sys.argv[2] if len(sys.argv) > 2 else "synth/stitched.png"
    os.chdir("/home/claude/akbmail")
    c = stitch(video, out)
    if os.path.exists("synth/ground_truth.png") and "synth" in video:
        validate(c, "synth/ground_truth.png")
