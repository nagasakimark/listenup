#!/usr/bin/env python3
"""New Horizon の語彙Excelから tools/vocab.json を作る。
  level 0 = 小5, 1 = 小6, 2 = 中1, 3 = 中2, 4 = 中3
  vocab.json: { "word": [level, "日本語の意味"] }   (その語が最初に出る学年)
使い方:  pip install openpyxl && python3 tools/build_vocab.py
"""
import json, re, pathlib, openpyxl

HERE = pathlib.Path(__file__).parent
cfg = json.loads((HERE / "elementary_split.json").read_text(encoding="utf-8"))
SIX = set(cfg["sixth_grade_genres"])
vocab = {}

def clean(s):
    return str(s).replace("’", "'").replace("‘", "'")

def add(entry, level, ja=""):
    entry = re.sub(r"\([^)]*\)", " ", clean(entry))  # (Riko)'s など
    words = re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)*", entry)
    single = len(words) == 1
    for w in words:
        k = w.lower()
        j = ja if single else ""
        if k not in vocab:
            vocab[k] = [level, j]
        else:
            if level < vocab[k][0]:
                vocab[k][0] = level
            if not vocab[k][1] and j:
                vocab[k][1] = j

def short_ja(s):
    s = str(s or "").strip().split("\n")[0]
    s = re.sub(r"【[^】]*】|［[^］]*］|\[[^\]]*\]", "", s)
    s = s.replace("…", "").replace("〜", "").replace("～", "")
    s = re.split(r"[、,；;]", s)[0]
    return s.strip()[:14]

# --- 小学校 ---
ws = openpyxl.load_workbook(HERE / "source" / "NHElementaryVocab.xlsx").active
for r in ws.iter_rows(min_row=2, values_only=True):
    if r[0] is None or not r[4]:
        continue
    lv = 1 if r[3] in SIX else 0
    add(r[4], lv, short_ja(r[5]))

# --- 中学校 ---
wb = openpyxl.load_workbook(HERE / "source" / "NHJHSVocab.xlsx")
ws = wb.worksheets[0]
for r in ws.iter_rows(min_row=4, values_only=True):
    if r[0] is None or not r[2] or r[10] not in (1, 2, 3):
        continue
    add(r[2], 1 + int(r[10]), short_ja(r[9]))
for r in wb.worksheets[1].iter_rows(min_row=4, values_only=True):      # 題材語
    if r[0] is not None and r[1] and r[3] in (1, 2, 3):
        add(r[1], 1 + int(r[3]), short_ja(r[2]))
for r in wb.worksheets[2].iter_rows(min_row=4, values_only=True):      # Word List 外の語
    if r[0] is not None and r[1] and r[4] in (1, 2, 3):
        add(r[1], 1 + int(r[4]), short_ja(r[3]))

out = HERE / "vocab.json"
out.write_text(json.dumps(vocab, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")
from collections import Counter
print(len(vocab), "words", dict(sorted(Counter(v[0] for v in vocab.values()).items())))
