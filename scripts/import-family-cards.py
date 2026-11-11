"""Extract the supplied print-and-play deck into server-only card data."""

import json
import sys
from pathlib import Path

from pypdf import PdfReader


root = Path(__file__).resolve().parents[1]
reader = PdfReader(root / "docs/CAH_Family_SmallCards.pdf")
deck = {"prompts": [], "answers": []}
if len(reader.pages) != 33:
    sys.exit("Unexpected PDF layout: expected 33 pages.")

for number, page in enumerate(reader.pages[2:], start=3):
    cells = {}

    def collect(text, cm, tm, font, size):
        if text.strip():
            column = int((tm[4] - 18) // 144)
            row = int((774 - tm[5]) // 144)
            if not 0 <= column < 4 or not 0 <= row < 5:
                raise ValueError(f"Unexpected text position on page {number}.")
            cells.setdefault((row, column), []).append(text.strip())

    page.extract_text(visitor_text=collect)
    target = deck["prompts" if number <= 7 else "answers"]
    for cell in sorted(cells):
        target.append(" ".join(" ".join(cells[cell]).split()))

if len(deck["prompts"]) != 95 or len(deck["answers"]) != 505:
    sys.exit("Unexpected card counts: expected 95 prompts and 505 answers.")

(root / "lib/family-cards.json").write_text(
    json.dumps(deck, ensure_ascii=True, indent=2) + "\n", encoding="utf-8"
)
print("Imported 95 prompts and 505 answers. Review the deck before deployment.")
