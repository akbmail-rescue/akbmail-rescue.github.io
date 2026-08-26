import glob, sys, json
from PIL import Image
W=sys.argv[1]
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
rows=[]; prevb=False; rises=0; segs=[]; cur=0
for i,p in enumerate(sorted(glob.glob(f"{W}/f_*.png"))):
    img=Image.open(p); w,h=img.size; g=img.convert("L"); bm=body_metric(g,w,h); dk=darkness(g,w,h); hd=header_metric(img.convert("RGB"),w,h)
    cat="fullscreen" if dk>0.5 else "loading" if bm<0.02 else "list" if bm<0.15 else "detail"
    b = cat=="loading" and hd>0.15
    if b and not prevb:
        rises+=1
        if cur: segs.append(cur)
        cur=0
    elif cat!="loading": cur+=1
    prevb=b
    rows.append({"i":i,"t":round(i/6,3),"bm":round(bm,5),"dk":round(dk,5),"hd":round(hd,5),"cat":cat,"boundary":b})
if cur: segs.append(cur)
json.dump(rows,open(sys.argv[2],"w"))
print("boundary_rises=",rises,"segments=",len(segs),segs, "boundary frames:",[r["i"] for r in rows if r["boundary"]])
