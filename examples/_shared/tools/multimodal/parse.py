"""Bounded, application-owned media decoding. No model credentials or fixture answers."""
import argparse, hashlib, json, subprocess, sys, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
p = argparse.ArgumentParser()
p.add_argument('path'); p.add_argument('mime'); p.add_argument('output')
p.add_argument('--asr-language', default='en'); p.add_argument('--asr-model', default='tiny.en'); p.add_argument('--ffmpeg', default='ffmpeg'); p.add_argument('--ffprobe', default='ffprobe')
a = p.parse_args(); path = Path(a.path); output = Path(a.output); output.mkdir(parents=True, exist_ok=True)
data = path.read_bytes(); blocks = []; images = []; details = {}
def block(location, text):
    if text.strip(): blocks.append({'location': location, 'text': text.strip()})
def image(file, location):
    from PIL import Image, ImageOps
    with Image.open(file) as im:
        if im.format not in ('PNG', 'JPEG'): raise ValueError('Unsupported image format')
        if im.width * im.height > 20_000_000: raise ValueError('Image exceeds pixel limit')
        im = ImageOps.exif_transpose(im).convert('RGB'); im.thumbnail((1280, 1280))
        target = output / (str(len(images)) + '.jpg'); im.save(target, quality=90)
    images.append({'location': location, 'path': str(target), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'mediaType': 'image/jpeg'})
if a.mime in ('application/pdf', 'audio/wav', 'audio/mpeg'):
    kind = 'pdf' if a.mime == 'application/pdf' else 'audio'
    shared = Path(__file__).parent.parent / 'file-ingestion' / 'parse.py'
    result = json.loads(subprocess.run([sys.executable, str(shared), kind, str(path), '--media-type', a.mime, '--asr-model', a.asr_model, '--asr-language', a.asr_language], check=True, capture_output=True, text=True, timeout=180).stdout)
    if kind == 'pdf':
        for n, text in enumerate(result['text'].split('\f'), 1): block('page:' + str(n), text)
    else:
        for segment in result['segments']: block('seconds:%s-%s' % (segment['start'], segment['end']), segment['text'])
        details['transcript'] = result['transcript']; details['segments'] = result['segments']
    engine = result['engine']
elif a.mime == 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    if not data.startswith(b'PK'): raise ValueError('Invalid DOCX signature')
    with zipfile.ZipFile(path) as z:
        if sum(i.file_size for i in z.infolist()) > 20_000_000: raise ValueError('DOCX expanded size exceeds limit')
        xml = z.read('word/document.xml')
        if b'<!DOCTYPE' in xml or b'<!ENTITY' in xml: raise ValueError('XML entities are not supported')
        root = ET.fromstring(xml); ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        for n, paragraph in enumerate(root.findall('.//w:body//w:p', ns), 1):
            block('paragraph:' + str(n), ''.join(t.text or '' for t in paragraph.findall('.//w:t', ns)))
    engine = 'OOXML body paragraphs and table cells'
elif a.mime in ('image/png', 'image/jpeg'):
    from PIL import Image
    with Image.open(path) as im:
        if im.format != {'image/png': 'PNG', 'image/jpeg': 'JPEG'}[a.mime]: raise ValueError('Image MIME mismatch')
    image(path, 'image:1'); engine = 'Pillow decode and EXIF orientation'
elif a.mime == 'video/mp4':
    if data[4:8] != b'ftyp': raise ValueError('Invalid MP4 signature')
    metadata = json.loads(subprocess.run([a.ffprobe, '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)], check=True, capture_output=True, text=True, timeout=20).stdout)
    duration = float(metadata['format']['duration'])
    if not 0 < duration <= 120: raise ValueError('Video must be at most 120 seconds')
    timestamps = [round(duration * f, 3) for f in (0.1, 0.5, 0.9)]
    for n, timestamp in enumerate(timestamps):
        frame = output / ('frame-%s.png' % n)
        subprocess.run([a.ffmpeg, '-v', 'error', '-y', '-ss', str(timestamp), '-i', str(path), '-frames:v', '1', '-vf', 'scale=640:-2', str(frame)], check=True, capture_output=True, timeout=30)
        image(frame, 'seconds:' + str(timestamp)); frame.unlink()
    details = {'durationSeconds': duration, 'sampledSeconds': timestamps, 'hasAudio': any(s['codec_type'] == 'audio' for s in metadata['streams']), 'audioAnalyzed': False}
    engine = 'FFmpeg three timestamped frames'
else: raise ValueError('Unsupported MIME')
if not blocks and not images: raise ValueError('No readable content')
if sum(len(b['text']) for b in blocks) > 32000: raise ValueError('Text exceeds 32000 character limit; split the input')
print(json.dumps({'engine': engine, 'blocks': blocks, 'images': images, 'details': details}))
