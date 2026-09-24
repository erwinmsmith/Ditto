"""Create physical test documents; only the acceptance runner reads expected answers."""
import argparse
import csv
import json
from pathlib import Path
import secrets
import shutil
import subprocess
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen.canvas import Canvas
from openpyxl import Workbook

parser = argparse.ArgumentParser()
parser.add_argument("directory")
args = parser.parse_args()
root = Path(args.directory)
root.mkdir(parents=True, exist_ok=True)
records = []
for format in ["pdf", "csv", "xlsx", "png", "jpg"]:
    code = "PICKUP-" + secrets.token_hex(3).upper()
    quantity = 2 + secrets.randbelow(18)
    text = f"Pickup code: {code}\nQuantity: {quantity}"
    path = root / ("pickup." + format)
    if format == "pdf":
        canvas = Canvas(str(path))
        canvas.setFont("Helvetica-Bold", 24)
        canvas.drawString(60, 740, "Pickup request")
        canvas.setFont("Helvetica", 18)
        canvas.drawString(60, 690, "Pickup code: " + code)
        canvas.drawString(60, 655, "Quantity: " + str(quantity))
        canvas.save()
        mime = "application/pdf"
    elif format == "csv":
        with path.open("w", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerows([["code", "quantity"], [code, str(quantity)]])
        mime = "text/csv"
    elif format == "xlsx":
        book = Workbook()
        book.active.append(["code", "quantity"])
        book.active.append([code, quantity])
        book.save(path)
        book.close()
        mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        image = Image.new("RGB", (1400, 320), "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.load_default(size=52)
        draw.multiline_text((50, 60), text, fill="black", font=font, spacing=30)
        image.save(path, quality=95)
        mime = "image/png" if format == "png" else "image/jpeg"
    records.append({"name": path.name, "mediaType": mime, "code": code, "quantity": quantity})
code = str(700 + secrets.randbelow(99))
quantity = 2 + secrets.randbelow(7)
spoken = f"The pickup code is {code}. The quantity is {quantity}."
if shutil.which("say"):
    source = root / "source.aiff"
    subprocess.run(["say", "-v", "Samantha", "-r", "145", "-o", str(source), spoken], check=True)
elif shutil.which("espeak"):
    source = root / "source.wav"
    subprocess.run(["espeak", "-w", str(source), spoken], check=True)
else:
    raise RuntimeError("Install say (macOS) or espeak (Linux) to generate the audio fixture")
for format, mime in [("wav", "audio/wav"), ("mp3", "audio/mpeg")]:
    path = root / ("pickup." + format)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(source), "-ar", "16000", "-ac", "1", str(path)], check=True)
    records.append({"name": path.name, "mediaType": mime, "code": code, "quantity": quantity})
(root / "manifest.json").write_text(json.dumps(records, indent=2) + "\n")
print(json.dumps({"files": len(records), "directory": str(root)}))
