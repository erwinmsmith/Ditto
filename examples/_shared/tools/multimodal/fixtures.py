"""Generate actual binary task inputs; expected answers are written separately for the test harness."""
import argparse, json, random, subprocess, zipfile
from pathlib import Path
from xml.sax.saxutils import escape
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
p=argparse.ArgumentParser();p.add_argument('directory');p.add_argument('mode');a=p.parse_args();root=Path(a.directory);root.mkdir(parents=True,exist_ok=True)
rng=random.SystemRandom();quota=rng.choice([40,60,80]);newquota=quota+20;values=[rng.choice([20,30,40]),70,50]
font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',28) if Path('/System/Library/Fonts/Supplemental/Arial.ttf').exists() else ImageFont.truetype('DejaVuSans.ttf',28)
base=['NimbusDesk pilot','Launch: 2026-11-16',f'Quota: {quota} teams','Retention: 30 days','Owner: Alice']
new=['NimbusDesk pilot','Launch: 2026-11-16',f'Quota: {newquota} teams','Retention: 90 days']
sources=[]
def source(name,mime): sources.append({'id':'source-'+str(len(sources)+1),'path':name,'mediaType':mime})
def pdf():
 c=canvas.Canvas(str(root/'brief.pdf')); c.setFont('Helvetica',16)
 for n,line in enumerate(base):c.drawString(60,760-n*36,line)
 c.save();source('brief.pdf','application/pdf')
def docx():
 ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
 document=f'<w:document xmlns:w="{ns}"><w:body>'+''.join('<w:p><w:r><w:t>'+escape(line)+'</w:t></w:r></w:p>' for line in new)+'<w:sectPr/></w:body></w:document>'
 with zipfile.ZipFile(root/'revision.docx','w',zipfile.ZIP_DEFLATED) as z:
  z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  z.writestr('word/document.xml',document)
 source('revision.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document')
instruction='Explain the supplied material and cite original evidence.';expected={}
if a.mode in ('document-parsing','document-comparison'):
 pdf();docx();expected={'quota':quota,'newQuota':newquota}
elif a.mode=='document-review':
 docx();instruction='Review against these rules: owner-required: an Owner field is mandatory. retention-limit: Retention must be at most 30 days. Identify missing information and violations separately.';expected={'rules':['owner-required','retention-limit']}
elif a.mode=='image-understanding':
 im=Image.new('RGB',(640,360),'white');d=ImageDraw.Draw(im);d.ellipse((60,100,220,260),fill='blue');d.rectangle((410,100,570,260),fill='red');im.save(root/'shapes.png');source('shapes.png','image/png');expected={'shapes':['circle','square']}
elif a.mode=='chart-understanding':
 im=Image.new('RGB',(720,480),'white');d=ImageDraw.Draw(im);d.text((130,12),'Monthly tickets',font=font,fill='black');d.line((80,60,80,400,660,400),fill='black',width=3)
 for n,(label,v) in enumerate(zip(['Jan','Feb','Mar'],values)):
  x=140+n*180;y=400-v*4;d.rectangle((x,y,x+90,399),fill='#2676c5');d.text((x+24,y-35),str(v),font=font,fill='black');d.text((x+15,413),label,font=font,fill='black')
 im.save(root/'chart.png');source('chart.png','image/png');expected={'series':dict(zip(['Jan','Feb','Mar'],values))}
elif a.mode in ('audio-transcription','meeting-notes'):
 text='We agreed to launch the pilot on Monday. Alice will send the report by Friday. Bob will review the budget by Thursday. The next meeting is Tuesday.'
 subprocess.run(['say','-v','Samantha','-r','145','-o',str(root/'speech.aiff'),text],check=True)
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(root/'speech.aiff'),'-ar','16000','-ac','1',str(root/'meeting.wav')],check=True);(root/'speech.aiff').unlink()
 source('meeting.wav','audio/wav');expected={'owners':['Alice','Bob'],'deadlines':['Friday','Thursday']}
elif a.mode=='video-understanding':
 for n,x in enumerate([100,320,540]):
  im=Image.new('RGB',(640,360),'white');d=ImageDraw.Draw(im);d.ellipse((x-55,125,x+55,235),fill='blue');im.save(root/f'scene{n}.png')
 subprocess.run(['ffmpeg','-v','error','-y','-framerate','1/2','-i',str(root/'scene%d.png'),'-t','6','-c:v','libx264','-pix_fmt','yuv420p','-r','24',str(root/'motion.mp4')],check=True)
 for n in range(3):(root/f'scene{n}.png').unlink()
 source('motion.mp4','video/mp4');expected={'direction':'right'}
else:raise ValueError('Unknown mode')
(root/'fixture.json').write_text(json.dumps({'sources':sources,'instruction':instruction}))
(root/'expected.json').write_text(json.dumps(expected))
