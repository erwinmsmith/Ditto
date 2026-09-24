"""Adapted from data-viz figure07/plot.py and vizlib.common.grouped_bars.
Retains canvas, axes, palette and grouped-bar positions. Removes unsupported
sample dots, uncertainty and significance annotations; plots actual order sums.
"""
import json, sys
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from matplotlib import font_manager
s=json.loads((Path(__file__).parent/'chart-style.json').read_text());r=json.load(sys.stdin)
rows=r['series'];s['categories']=sorted({row['region'] for row in rows});s['groups']=['paid','pending','refunded']
for filename in ['Arial.ttf','Arial Bold.ttf']:
    p=Path('/System/Library/Fonts/Supplemental')/filename
    if p.exists():font_manager.fontManager.addfont(p)
family='Arial' if 'Arial' in {f.name for f in font_manager.fontManager.ttflist} else 'DejaVu Sans'
plt.rcParams.update({'font.family':[family,'DejaVu Sans'],'font.size':s['font_size'],'axes.linewidth':s['line_width'],'svg.fonttype':'none','svg.hashsalt':'ditto-data-code','savefig.facecolor':'white'})
fig=plt.figure(figsize=(s['width']/s['dpi'],s['height']/s['dpi']),dpi=s['dpi'],facecolor='white')
x,y,w,h=s['axes'];ax=fig.add_axes([x/s['width'],1-(y+h)/s['height'],w/s['width'],h/s['height']])
for name,spine in ax.spines.items():spine.set_visible(name in ['left','bottom'])
width,spacing=0.72,3.85
for i,category in enumerate(s['categories']):
    for j,(group,color) in enumerate(zip(s['groups'],s['colors'])):
        matches=[v for v in rows if v['region']==category and v['status']==group]
        if len(matches)!=1:raise ValueError('Expected one computed total per category/status')
        value=matches[0]['revenueCents']/100
        if value<0:raise ValueError('Expected nonnegative gross order value')
        ax.bar(i*spacing+j,value,width,fc=color,ec='#333',lw=1.5)
ax.set_xlim(-1,(len(s['categories'])-1)*spacing+len(s['groups']))
ax.set_xticks([i*spacing+(len(s['groups'])-1)/2 for i in range(len(s['categories']))],s['categories'])
ax.set_ylabel(s['ylabel']);ax.set_ylim(0,max(v['revenueCents']/100 for v in rows)*1.18 or 1);ax.tick_params(axis='x',length=0)
fig.legend([Patch(fc=cc,ec='#555',lw=1.5) for cc in s['colors']],s['groups'],title='Status',loc='upper left',bbox_to_anchor=(0.768,0.998),frameon=False,fontsize=19,title_fontsize=22,handlelength=1.2,labelspacing=0.45,handletextpad=0.35)
fig.text(106/s['width'],1-58/s['height'],s['title'],fontsize=22)
output=Path(r['directory']);output.mkdir(parents=True,exist_ok=True)
for fmt in ('png','svg'):fig.savefig(output/('chart.'+fmt),dpi=s['dpi'],metadata={'Date':None} if fmt=='svg' else {})
plt.close(fig)
print(json.dumps({'files':['chart.png','chart.svg'],'bars':len(rows),'unit':'USD','sourceUnit':'cents','template':'data-viz/figure07'}))
