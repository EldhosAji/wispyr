/**
 * Excel Chart Injection — embeds charts directly into worksheets via Open XML.
 *
 * Uses the twoCellAnchor approach (chart embedded in worksheet) which is
 * the most compatible method across all Excel versions.
 */

// ─── Types ───

export interface ChartDefinition {
  /** Chart type */
  type: 'pie' | 'bar' | 'column' | 'line' | 'doughnut' | 'area'
  /** Chart title */
  title: string
  /** Sheet name where the chart's data lives AND where chart will be placed */
  dataSheet: string
  /** Column letter for category labels (e.g. "A") */
  categoryColumn: string
  /** Column letter for values (e.g. "B") — can be comma-separated for multi-series: "B,C,D" */
  valueColumn: string
  /** First data row (1-based, typically 2 to skip header) */
  startRow: number
  /** Last data row (1-based) */
  endRow: number
}

// ─── Main ───

export function addChartsToExcel(filePath: string, charts: ChartDefinition[]): void {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(filePath)

  // Group charts by target sheet
  const chartsBySheet = new Map<string, { chart: ChartDefinition; index: number }[]>()
  charts.forEach((chart, i) => {
    const sheet = chart.dataSheet
    if (!chartsBySheet.has(sheet)) chartsBySheet.set(sheet, [])
    chartsBySheet.get(sheet)!.push({ chart, index: i + 1 })
  })

  // Find which sheet file corresponds to which sheet name
  const sheetMap = resolveSheetFiles(zip)

  let drawingCounter = 0

  for (const [sheetName, chartDefs] of chartsBySheet) {
    const sheetFile = sheetMap.get(sheetName)
    if (!sheetFile) {
      console.log(`[Chart] Sheet "${sheetName}" not found, skipping charts`)
      continue
    }

    drawingCounter++
    const drawingId = drawingCounter

    // Create all charts for this sheet
    const anchors: string[] = []

    for (let ci = 0; ci < chartDefs.length; ci++) {
      const { chart, index } = chartDefs[ci]
      const chartFileName = `chart${index}.xml`

      // Add chart XML
      zip.addFile(`xl/charts/${chartFileName}`, Buffer.from(buildChartXml(chart)))

      // Build anchor — stack charts vertically, offset to the right of data
      const startCol = colLetterToNumber(chart.valueColumn.split(',').pop()!) + 1
      const startRow = ci * 17
      anchors.push(buildAnchor(index, startCol, startRow, startCol + 9, startRow + 16))
    }

    // Create drawing with all anchors
    const drawingXml = buildDrawingXml(anchors)
    zip.addFile(`xl/drawings/drawing${drawingId}.xml`, Buffer.from(drawingXml))

    // Drawing rels — link to each chart
    const drawingRels = buildDrawingRels(chartDefs.map(cd => cd.index))
    zip.addFile(`xl/drawings/_rels/drawing${drawingId}.xml.rels`, Buffer.from(drawingRels))

    // Add <drawing r:id="rIdN"/> to the worksheet XML
    let sheetXml = zip.getEntry(sheetFile)!.getData().toString()
    const drawingRid = `rId${100 + drawingId}`
    if (!sheetXml.includes('<drawing')) {
      sheetXml = sheetXml.replace('</worksheet>', `<drawing r:id="${drawingRid}"/></worksheet>`)
      zip.updateFile(sheetFile, Buffer.from(sheetXml))
    }

    // Add/update sheet rels
    const sheetRelsPath = sheetFile.replace('worksheets/', 'worksheets/_rels/') + '.rels'
    const sheetRel = `<Relationship Id="${drawingRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingId}.xml"/>`
    const existingRels = zip.getEntry(sheetRelsPath)
    if (existingRels) {
      let rels = existingRels.getData().toString()
      if (!rels.includes(drawingRid)) {
        rels = rels.replace('</Relationships>', `${sheetRel}</Relationships>`)
        zip.updateFile(sheetRelsPath, Buffer.from(rels))
      }
    } else {
      zip.addFile(sheetRelsPath, Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRel}</Relationships>`
      ))
    }
  }

  // Update [Content_Types].xml
  let ct = zip.getEntry('[Content_Types].xml')!.getData().toString()
  for (const chartDefs of chartsBySheet.values()) {
    for (const { index } of chartDefs) {
      const override = `<Override PartName="/xl/charts/chart${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`
      if (!ct.includes(`chart${index}.xml`)) {
        ct = ct.replace('</Types>', `${override}</Types>`)
      }
    }
  }
  if (!ct.includes('drawing+xml"')) {
    for (let i = 1; i <= drawingCounter; i++) {
      ct = ct.replace('</Types>', `<Override PartName="/xl/drawings/drawing${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`)
    }
  }
  zip.updateFile('[Content_Types].xml', Buffer.from(ct))

  zip.writeZip(filePath)
}

// ─── Chart XML Builder ───

function buildChartXml(chart: ChartDefinition): string {
  const sheetRef = chart.dataSheet
  const valueCols = chart.valueColumn.split(',').map(c => c.trim())
  const isMultiSeries = valueCols.length > 1
  const chartTag = getChartTag(chart.type)
  const needsAxes = !['pie', 'doughnut'].includes(chart.type)

  let seriesXml = ''
  for (let si = 0; si < valueCols.length; si++) {
    const vc = valueCols[si]
    seriesXml += `
        <c:ser>
          <c:idx val="${si}"/>
          <c:order val="${si}"/>
          <c:tx><c:strRef><c:f>'${sheetRef}'!$${vc}$1</c:f></c:strRef></c:tx>
          ${!isMultiSeries ? buildDataPointColors(chart.endRow - chart.startRow + 1) : ''}
          <c:cat><c:strRef><c:f>'${sheetRef}'!$${chart.categoryColumn}$${chart.startRow}:$${chart.categoryColumn}$${chart.endRow}</c:f></c:strRef></c:cat>
          <c:val><c:numRef><c:f>'${sheetRef}'!$${vc}$${chart.startRow}:$${vc}$${chart.endRow}</c:f></c:numRef></c:val>
        </c:ser>`
  }

  let axesXml = ''
  if (needsAxes) {
    seriesXml += '\n        <c:axId val="1"/><c:axId val="2"/>'
    axesXml = `
      <c:catAx>
        <c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/>
        <c:numFmt formatCode="#,##0" sourceLinked="0"/>
      </c:valAx>`
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
              xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title>
      <c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1400" b="1"/><a:t>${escapeXml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx>
      <c:overlay val="0"/>
    </c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:${chartTag}>
        <c:varyColors val="1"/>${seriesXml}
      </c:${chartTag}>${axesXml}
    </c:plotArea>
    <c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>
    <c:plotVisOnly val="1"/>
    <c:dispBlanksAs val="gap"/>
  </c:chart>
</c:chartSpace>`
}

// ─── Drawing XML ───

function buildAnchor(chartIndex: number, fromCol: number, fromRow: number, toCol: number, toRow: number): string {
  return `
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="${chartIndex + 1}" name="Chart ${chartIndex}"/>
        <xdr:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></xdr:cNvGraphicFramePr>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${chartIndex}"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>`
}

function buildDrawingXml(anchors: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.join('')}
</xdr:wsDr>`
}

function buildDrawingRels(chartIndices: number[]): string {
  const rels = chartIndices.map(i =>
    `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${i}.xml"/>`
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`
}

// ─── Helpers ───

function resolveSheetFiles(zip: any): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const wbXml = zip.getEntry('xl/workbook.xml')?.getData().toString() || ''
    const wbRels = zip.getEntry('xl/_rels/workbook.xml.rels')?.getData().toString() || ''

    // Parse sheet names and rIds
    const sheetMatches = wbXml.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/?>/g)
    for (const m of sheetMatches) {
      const name = m[1]
      const rId = m[2]
      // Find target in rels
      const relMatch = wbRels.match(new RegExp(`Id="${rId}"[^>]*Target="([^"]*)"`, 'i'))
      if (relMatch) {
        const target = relMatch[1].startsWith('/') ? relMatch[1].slice(1) : `xl/${relMatch[1]}`
        map.set(name, target)
      }
    }
  } catch { /* skip */ }
  return map
}

function getChartTag(type: string): string {
  switch (type) {
    case 'pie': return 'pieChart'
    case 'doughnut': return 'doughnutChart'
    case 'bar': return 'barChart'
    case 'line': return 'lineChart'
    case 'area': return 'areaChart'
    case 'column': return 'barChart'
    default: return 'barChart'
  }
}

function buildDataPointColors(count: number): string {
  const colors = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '264478', '9B57A0', '636363', 'EB7E30', '44546A', 'BF8F00', '2E75B6', 'C00000', '00B050']
  let xml = ''
  for (let i = 0; i < Math.min(count, colors.length); i++) {
    xml += `\n          <c:dPt><c:idx val="${i}"/><c:spPr><a:solidFill><a:srgbClr val="${colors[i]}"/></a:solidFill></c:spPr></c:dPt>`
  }
  return xml
}

function colLetterToNumber(letter: string): number {
  let num = 0
  for (let i = 0; i < letter.length; i++) {
    num = num * 26 + (letter.charCodeAt(i) - 64)
  }
  return num
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
