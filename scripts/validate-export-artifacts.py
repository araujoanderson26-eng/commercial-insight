"""Read-only verification and page rendering of synthetic export artifacts."""
from pathlib import Path
import json,zipfile,xml.etree.ElementTree as ET,math
import openpyxl,pdfplumber
root=Path('outputs/executive-exports'); images=root/'pages';images.mkdir(exist_ok=True)
results=[]
expected={x['file']:x['sheets'] for x in json.loads((root/'expected-values.json').read_text(encoding='utf8'))}
for file in root.glob('*.xlsx'):
    with zipfile.ZipFile(file) as z:
        assert z.testzip() is None
        for name in z.namelist():
            if name.endswith(('.xml','.rels')): ET.fromstring(z.read(name))
    book=openpyxl.load_workbook(file,data_only=False)
    assert book.sheetnames[0]=='Resumo Executivo'
    count=0
    for sheet in book:
        assert sheet.sheet_view.showGridLines is False
        for row in sheet:
            for cell in row:
                assert cell.data_type!='f', 'No user text may become a cell formula'
                if isinstance(cell.value,(int,float)): count+=1
        if sheet.title not in ('Resumo Executivo','Pauta','Contexto'):
            assert sheet.freeze_panes=='C8';assert sheet.auto_filter.ref
            assert sheet['C9'].value is not None
    chart_count=sum(len(s._charts) for s in book)
    assert chart_count>=1
    checked=0
    for source in expected[file.name]:
        sheet=book[source['name']]
        body=source['rows'][1:] if source['report'] else source['rows']
        for ri,row in enumerate(body,8):
            for ci,value in enumerate(row,1):
                actual=sheet.cell(ri,ci).value
                if source['report'] and ci>=3 and (ci-3)%4==3:
                    # Margin is expressed in percentage points; other deltas are native Excel ratios.
                    label=source['rows'][0][ci-1]
                    if value is not None and '(p.p.)' not in label:value=value/100
                    if value is None and row[ci-4] is not None and row[ci-3] is not None:value='Não comparável'
                if isinstance(value,(float,int)):assert isinstance(actual,(float,int)) and math.isclose(value,actual,rel_tol=1e-14,abs_tol=1e-10),(file.name,ri,ci,value,actual)
                else:assert (value or None)==(actual or None),(file.name,ri,ci,value,actual)
                checked+=1
    results.append(dict(file=file.name,originalCellsCompared=checked))
    results.append(dict(file=file.name,numericCells=count,charts=chart_count,xmlValid=True))
for file in root.glob('*.pdf'):
    with pdfplumber.open(file) as pdf:
        pages=[]
        for i,p in enumerate(pdf.pages):
            text=p.extract_text() or ''
            assert len(text.strip())>50,(file.name,i,'blank page')
            body=[c for c in p.chars if 46<c['top']<p.height-39 and c['text'].strip()]
            assert len(body)>30,(file.name,i,'unexpected page without substantive content')
            assert '###' not in text,(file.name,i,'Excel width overflow')
            assert 'COMMERCIAL INSIGHT' in text.upper() or file.stem.endswith('-excel'),(file.name,i,'header missing')
            if not file.stem.endswith('-excel'):
                assert 'Página' in text,(file.name,i,'page counter missing')
                out=[c for c in p.chars if c['text'].strip() and (c['x0']<32 or c['x1']>p.width-32 or c['top']<10 or c['bottom']>p.height-10)]
                assert not out,(file.name,i,'out of bounds',out[:2])
                # Footer and body occupy disjoint bands; header rows repeat across table fragments.
                words=p.extract_words(x_tolerance=1,y_tolerance=2)
                overlaps=[]
                for j,a in enumerate(words):
                    for b in words[j+1:]:
                        dx=min(a['x1'],b['x1'])-max(a['x0'],b['x0'])
                        dy=min(a['bottom'],b['bottom'])-max(a['top'],b['top'])
                        if dx>2 and dy>3: overlaps.append((a['text'],b['text']))
                assert not overlaps,(file.name,i,'overlapping text',overlaps[:3])
            p.to_image(resolution=90).save(images/(file.stem+f'-{i+1:02d}.png'))
            pages.append(dict(page=i+1,width=p.width,height=p.height,characters=len(p.chars)))
        results.append(dict(file=file.name,pages=pages))
        for stale in images.glob(file.stem+'-*.png'):
            try: number=int(stale.stem.rsplit('-',1)[1])
            except ValueError:continue
            if number>len(pdf.pages):stale.unlink()
(root/'validation.json').write_text(json.dumps(results,indent=2),encoding='utf8')
print(json.dumps([dict(file=r['file'],pages=len(r['pages'])) if 'pages' in r else r for r in results]))
