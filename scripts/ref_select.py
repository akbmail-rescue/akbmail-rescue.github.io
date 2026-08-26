"""rescue.py の F-3 ロジック(OCR 抜き)を走らせ、pHash と代表フレーム選定結果をフィクスチャ化する."""
import glob, sys, json
from PIL import Image
import imagehash, numpy as np
W=sys.argv[1]; OUT=sys.argv[2]
def body_metric(g,w,h):
    px=g.crop((0,int(h*0.28),w,int(h*0.90))).tobytes(); return sum(1 for p in px if p<240)/len(px)
def darkness(g,w,h):
    px=g.crop((0,int(h*0.10),w,int(h*0.16))).tobytes()+g.crop((0,int(h*0.92),w,int(h*0.98))).tobytes(); return sum(1 for p in px if p<60)/len(px)
def header_metric(rgb,w,h):
    px=rgb.crop((int(w*0.06),int(h*0.145),int(w*0.15),int(h*0.19))).tobytes(); n=len(px)//3; sat=0
    for i in range(0,len(px),3):
        mx=max(px[i],px[i+1],px[i+2]); mn=min(px[i],px[i+1],px[i+2])
        if (mx-mn)*5>mx: sat+=1
    return sat/n
frames=[]
for i,p in enumerate(sorted(glob.glob(f"{W}/f_*.png"))):
    img=Image.open(p); w,h=img.size; g=img.convert("L"); bm=body_metric(g,w,h); dk=darkness(g,w,h); hd=header_metric(img.convert("RGB"),w,h)
    cat="fullscreen" if dk>0.5 else "loading" if bm<0.02 else "list" if bm<0.15 else "detail"
    hs=imagehash.phash(g.resize((256,256)))
    frames.append({"i":i,"t":round(i/6,3),"bm":bm,"cat":cat,"boundary":cat=="loading" and hd>0.15,"hash":str(hs),"_h":hs})
segments=[];cur=[];prevb=False
for fr in frames:
    if fr["boundary"] and not prevb:
        if cur: segments.append(cur)
        cur=[]
    elif fr["cat"]!="loading": cur.append(fr)
    prevb=fr["boundary"]
if cur: segments.append(cur)
seen=[]; mails=[]; images=[]
def is_dup(h): return any(h-s<=6 for s in seen)
for si,seg in enumerate(segments):
    details=[f for f in seg if f["cat"]=="detail"]
    if details:
        stable=[details[i] for i in range(1,len(details)) if details[i]["_h"]-details[i-1]["_h"]<=2]
        pool=stable or details
        best=max(pool,key=lambda f:f["bm"])
        dup=is_dup(best["_h"])
        mails.append({"seg":si,"index":best["i"],"t":best["t"],"bm":round(best["bm"],5),"hash":best["hash"],"fromStable":bool(stable),"dup":dup})
        if not dup: seen.append(best["_h"])
    fulls=[f for f in seg if f["cat"]=="fullscreen"]
    for i in range(1,len(fulls)):
        if fulls[i]["_h"]-fulls[i-1]["_h"]<=2 and not is_dup(fulls[i]["_h"]):
            seen.append(fulls[i]["_h"]); images.append({"seg":si,"index":fulls[i]["i"],"t":fulls[i]["t"],"hash":fulls[i]["hash"]})
out={"frames":[{k:v for k,v in f.items() if k!="_h"} for f in frames],"mails":mails,"images":images}
json.dump(out,open(OUT,"w"))
print(f"segments={len(segments)} mails_saved={sum(1 for m in mails if not m['dup'])} mails_dup={sum(1 for m in mails if m['dup'])} images={len(images)}")
for m in mails: print("  mail",m)
for m in images: print("  image",m)
