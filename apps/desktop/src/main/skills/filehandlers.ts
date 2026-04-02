/**
 * Rich file type handlers for Wispyr.
 * Supports: Excel, Word, PDF, PowerPoint, CSV, ZIP, YAML, XML, Images, and more.
 */
import { join, extname } from 'path'
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs'
import { addChartsToExcel, type ChartDefinition } from './excel-charts'

// ─── Types ───
export interface FileResult {
  success: boolean
  log: string
  result: string
  error?: string
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

// ═══════════════════════════════════════════════
// EXCEL (.xlsx, .xls)
// ═══════════════════════════════════════════════

export async function writeExcel(filePath: string, data: { sheets: Array<{ name: string; headers?: string[]; rows: any[][] }>; charts?: ChartDefinition[] }): Promise<FileResult> {
  try {
    const ExcelJS = require('exceljs')
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Wispyr'
    workbook.created = new Date()

    for (const sheet of data.sheets) {
      const ws = workbook.addWorksheet(sheet.name)

      // If headers not provided, use the first row as headers
      let headers = sheet.headers
      let dataRows = sheet.rows || []
      if (!headers || headers.length === 0) {
        if (dataRows.length > 0) {
          headers = dataRows[0].map((v: any) => String(v))
          dataRows = dataRows.slice(1)
        } else {
          headers = ['Column1']
        }
      }

      // Add headers with styling
      ws.columns = headers.map((h: string) => ({
        header: h,
        key: h.toLowerCase().replace(/\s+/g, '_'),
        width: Math.max(h.length + 4, 15),
      }))

      // Style header row
      ws.getRow(1).font = { bold: true }
      ws.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' },
      }
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }

      // Add data rows
      for (const row of dataRows) {
        const rowData: Record<string, any> = {}
        headers.forEach((h: string, i: number) => {
          rowData[h.toLowerCase().replace(/\s+/g, '_')] = row[i]
        })
        ws.addRow(rowData)
      }

      // Auto-filter
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: headers.length },
      }
    }

    await workbook.xlsx.writeFile(filePath)

    // Inject charts if requested (ExcelJS can't create charts, so we use Open XML injection)
    let chartInfo = ''
    if (data.charts && data.charts.length > 0) {
      try {
        addChartsToExcel(filePath, data.charts)
        chartInfo = `, ${data.charts.length} chart(s) added`
      } catch (chartErr: any) {
        chartInfo = ` (chart injection failed: ${chartErr.message})`
      }
    }

    const stat = statSync(filePath)
    const totalRows = data.sheets.reduce((sum, s) => sum + (s.rows?.length || 0), 0)

    return {
      success: true,
      log: `Created Excel: ${filePath}\nSize: ${formatBytes(stat.size)}\nSheets: ${data.sheets.map(s => `${s.name} (${(s.rows?.length || 0)} rows)`).join(', ')}${chartInfo}`,
      result: `Excel created: ${data.sheets.length} sheets, ${totalRows} total rows (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to create Excel: ${err.message}`, result: '', error: err.message }
  }
}

export async function readExcel(filePath: string): Promise<FileResult> {
  try {
    const ExcelJS = require('exceljs')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    const stat = statSync(filePath)
    const lines: string[] = [
      `Read Excel: ${filePath}`,
      `Size: ${formatBytes(stat.size)}`,
      `Sheets: ${workbook.worksheets.length}`,
      '',
    ]

    for (const ws of workbook.worksheets) {
      lines.push(`── Sheet: ${ws.name} (${ws.rowCount} rows × ${ws.columnCount} cols) ──`)
      // Show first 15 rows
      ws.eachRow({ includeEmpty: false }, (row: any, rowNum: number) => {
        if (rowNum <= 15) {
          const vals = row.values.slice(1) // values[0] is undefined in exceljs
          lines.push(`  Row ${rowNum}: ${vals.map((v: any) => v?.toString() || '').join(' | ')}`)
        }
      })
      if (ws.rowCount > 15) lines.push(`  ... and ${ws.rowCount - 15} more rows`)
      lines.push('')
    }

    return {
      success: true,
      log: lines.join('\n'),
      result: `Read ${workbook.worksheets.length} sheets from Excel (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to read Excel: ${err.message}`, result: '', error: err.message }
  }
}

// ═══════════════════════════════════════════════
// WORD (.docx)
// ═══════════════════════════════════════════════

export async function writeDocx(filePath: string, data: { title?: string; content: Array<{ type: 'heading' | 'paragraph' | 'bullet' | 'table'; text?: string; level?: number; items?: string[]; headers?: string[]; rows?: string[][] }> }): Promise<FileResult> {
  try {
    const docx = require('docx')
    const children: any[] = []

    for (const block of data.content) {
      switch (block.type) {
        case 'heading':
          children.push(new docx.Paragraph({
            text: block.text || '',
            heading: block.level === 1 ? docx.HeadingLevel.HEADING_1 :
                     block.level === 2 ? docx.HeadingLevel.HEADING_2 :
                     docx.HeadingLevel.HEADING_3,
          }))
          break

        case 'paragraph':
          children.push(new docx.Paragraph({ text: block.text || '' }))
          break

        case 'bullet':
          for (const item of (block.items || [])) {
            children.push(new docx.Paragraph({
              text: item,
              bullet: { level: 0 },
            }))
          }
          break

        case 'table':
          if (block.headers && block.rows) {
            const tableRows = [
              new docx.TableRow({
                children: block.headers.map((h: string) =>
                  new docx.TableCell({
                    children: [new docx.Paragraph({ text: h, bold: true })],
                    shading: { fill: '4472C4', color: 'FFFFFF' },
                  })
                ),
              }),
              ...block.rows.map((row: string[]) =>
                new docx.TableRow({
                  children: row.map((cell: string) =>
                    new docx.TableCell({
                      children: [new docx.Paragraph({ text: cell })],
                    })
                  ),
                })
              ),
            ]
            children.push(new docx.Table({ rows: tableRows }))
          }
          break
      }
    }

    const doc = new docx.Document({
      creator: 'Wispyr',
      title: data.title || 'Document',
      sections: [{ children }],
    })

    const buffer = await docx.Packer.toBuffer(doc)
    writeFileSync(filePath, buffer)
    const stat = statSync(filePath)

    return {
      success: true,
      log: `Created Word document: ${filePath}\nSize: ${formatBytes(stat.size)}\nElements: ${data.content.length} blocks`,
      result: `Word document created: ${data.content.length} blocks (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to create DOCX: ${err.message}`, result: '', error: err.message }
  }
}

export async function readDocx(filePath: string): Promise<FileResult> {
  try {
    const mammoth = require('mammoth')
    const result = await mammoth.extractRawText({ path: filePath })
    const stat = statSync(filePath)

    const text = result.value || ''
    const preview = text.substring(0, 2000)

    return {
      success: true,
      log: `Read Word document: ${filePath}\nSize: ${formatBytes(stat.size)}\nText length: ${text.length} chars\n\n── Content ──\n${preview}${text.length > 2000 ? '\n...(truncated)' : ''}`,
      result: `Read DOCX: ${text.length} chars (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to read DOCX: ${err.message}`, result: '', error: err.message }
  }
}

// ═══════════════════════════════════════════════
// PDF
// ═══════════════════════════════════════════════

export async function writePdf(filePath: string, data: { title?: string; content: Array<{ type: 'heading' | 'paragraph' | 'list' | 'table'; text?: string; fontSize?: number; items?: string[]; headers?: string[]; rows?: string[][] }> }): Promise<FileResult> {
  try {
    const PDFDocument = require('pdfkit')
    const { createWriteStream, mkdirSync } = require('fs')
    const { dirname } = require('path')

    // Ensure directory exists
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })

    return new Promise<FileResult>((resolve) => {
      const doc = new PDFDocument({ margin: 50 })
      const stream = createWriteStream(filePath)
      doc.pipe(stream)

      // Title
      if (data.title) {
        doc.fontSize(22).font('Helvetica-Bold').text(data.title, { align: 'center' })
        doc.moveDown()
      }

      for (const block of data.content) {
        switch (block.type) {
          case 'heading':
            doc.fontSize(block.fontSize || 16).font('Helvetica-Bold').text(block.text || '')
            doc.moveDown(0.5)
            break

          case 'paragraph':
            doc.fontSize(block.fontSize || 11).font('Helvetica').text(block.text || '', { lineGap: 4 })
            doc.moveDown()
            break

          case 'list':
            doc.fontSize(11).font('Helvetica')
            for (const item of (block.items || [])) {
              doc.text(`  •  ${item}`, { lineGap: 3 })
            }
            doc.moveDown()
            break

          case 'table':
            if (block.headers && block.rows) {
              const colWidth = (doc.page.width - 100) / block.headers.length
              // Header row
              doc.fontSize(10).font('Helvetica-Bold')
              let x = 50
              for (const h of block.headers) {
                doc.text(h, x, doc.y, { width: colWidth, continued: false })
                x += colWidth
              }
              doc.moveDown(0.3)
              doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke()
              doc.moveDown(0.3)
              // Data rows
              doc.font('Helvetica').fontSize(10)
              for (const row of block.rows) {
                x = 50
                const y = doc.y
                for (const cell of row) {
                  doc.text(cell, x, y, { width: colWidth })
                  x += colWidth
                }
                doc.moveDown()
              }
              doc.moveDown()
            }
            break
        }
      }

      doc.end()
      stream.on('finish', () => {
        const stat = statSync(filePath)
        resolve({
          success: true,
          log: `Created PDF: ${filePath}\nSize: ${formatBytes(stat.size)}\nBlocks: ${data.content.length}`,
          result: `PDF created: ${data.content.length} blocks (${formatBytes(stat.size)})`,
        })
      })
      stream.on('error', (err: any) => {
        resolve({ success: false, log: `Failed to write PDF: ${err.message}`, result: '', error: err.message })
      })
    })
  } catch (err: any) {
    return { success: false, log: `Failed to create PDF: ${err.message}`, result: '', error: err.message }
  }
}

export async function readPdf(filePath: string): Promise<FileResult> {
  try {
    const stat = statSync(filePath)
    // Basic PDF info without pdf-parse (which has runtime issues with Electron)
    const buffer = readFileSync(filePath)
    // Count pages by searching for /Type /Page in the raw PDF
    const raw = buffer.toString('latin1')
    const pageMatches = raw.match(/\/Type\s*\/Page[^s]/g)
    const pageCount = pageMatches ? pageMatches.length : '?'

    return {
      success: true,
      log: `Read PDF: ${filePath}\nSize: ${formatBytes(stat.size)}\nPages: ~${pageCount}\n\n(PDF content is binary — open the file to view it)`,
      result: `PDF: ~${pageCount} pages (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to read PDF: ${err.message}`, result: '', error: err.message }
  }
}

// ═══════════════════════════════════════════════
// POWERPOINT (.pptx)
// ═══════════════════════════════════════════════

export async function writePptx(filePath: string, data: { title?: string; slides: Array<{ title: string; content?: string; bullets?: string[]; notes?: string }> }): Promise<FileResult> {
  try {
    const PptxGenJS = require('pptxgenjs')
    const pptx = new PptxGenJS()
    pptx.author = 'Wispyr'
    pptx.title = data.title || 'Presentation'

    for (const slideData of data.slides) {
      const slide = pptx.addSlide()

      // Title
      slide.addText(slideData.title, {
        x: 0.5, y: 0.3, w: '90%', h: 1,
        fontSize: 28, bold: true, color: '2B579A',
      })

      // Content
      if (slideData.content) {
        slide.addText(slideData.content, {
          x: 0.5, y: 1.5, w: '90%', h: 3.5,
          fontSize: 16, color: '333333', lineSpacingMultiple: 1.3,
        })
      }

      // Bullets
      if (slideData.bullets && slideData.bullets.length > 0) {
        const bulletText = slideData.bullets.map((b: string) => ({
          text: b,
          options: { fontSize: 16, bullet: true, color: '333333', lineSpacingMultiple: 1.5 },
        }))
        slide.addText(bulletText, {
          x: 0.5, y: 1.5, w: '90%', h: 3.5,
        })
      }

      // Speaker notes
      if (slideData.notes) {
        slide.addNotes(slideData.notes)
      }
    }

    await pptx.writeFile({ fileName: filePath })
    const stat = statSync(filePath)

    return {
      success: true,
      log: `Created PowerPoint: ${filePath}\nSize: ${formatBytes(stat.size)}\nSlides: ${data.slides.length}\n\nSlide titles:\n${data.slides.map((s, i) => `  ${i + 1}. ${s.title}`).join('\n')}`,
      result: `PowerPoint created: ${data.slides.length} slides (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to create PPTX: ${err.message}`, result: '', error: err.message }
  }
}

// ═══════════════════════════════════════════════
// CSV (enhanced)
// ═══════════════════════════════════════════════

export async function writeCsv(filePath: string, data: any): Promise<FileResult> {
  try {
    let output: string

    // Handle plain text CSV content (string passed directly)
    if (typeof data === 'string') {
      output = data
    } else if (data.headers && data.rows) {
      // Structured data with headers and rows
      const { stringify } = require('csv-stringify/sync')
      output = stringify([data.headers, ...data.rows])
    } else if (data.headers && !data.rows) {
      // Headers only, no rows
      output = data.headers.join(',') + '\n'
    } else {
      // Fallback: stringify whatever we got
      output = typeof data.content === 'string' ? data.content : JSON.stringify(data, null, 2)
    }

    writeFileSync(filePath, output, 'utf-8')
    const stat = statSync(filePath)

    const lines = output.split('\n').filter(l => l.trim())
    return {
      success: true,
      log: `Created CSV: ${filePath}\nSize: ${formatBytes(stat.size)}\nLines: ${lines.length}\n\n── Preview ──\n${output.substring(0, 500)}`,
      result: `CSV created: ${lines.length} lines (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to create CSV: ${err.message}`, result: '', error: err.message }
  }
}

export async function readCsv(filePath: string): Promise<FileResult> {
  try {
    const { parse } = require('csv-parse/sync')
    const raw = readFileSync(filePath, 'utf-8')
    const records = parse(raw, { columns: true, skip_empty_lines: true })
    const stat = statSync(filePath)

    const headers = records.length > 0 ? Object.keys(records[0]) : []
    const lines = [
      `Read CSV: ${filePath}`,
      `Size: ${formatBytes(stat.size)}`,
      `Rows: ${records.length}, Columns: ${headers.length}`,
      `Headers: ${headers.join(', ')}`,
      '',
      '── Data ──',
    ]
    for (const row of records.slice(0, 15)) {
      lines.push(`  ${headers.map(h => row[h]).join(' | ')}`)
    }
    if (records.length > 15) lines.push(`  ... and ${records.length - 15} more rows`)

    return {
      success: true,
      log: lines.join('\n'),
      result: `Read CSV: ${records.length} rows × ${headers.length} columns`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to read CSV: ${err.message}`, result: '', error: err.message }
  }
}

// ═══════════════════════════════════════════════
// ZIP Archives
// ═══════════════════════════════════════════════

export function writeZip(filePath: string, data: { files: Array<{ name: string; content: string }> }): FileResult {
  try {
    const AdmZip = require('adm-zip')
    const zip = new AdmZip()
    for (const f of data.files) {
      zip.addFile(f.name, Buffer.from(f.content, 'utf-8'))
    }
    zip.writeZip(filePath)
    const stat = statSync(filePath)

    return {
      success: true,
      log: `Created ZIP: ${filePath}\nSize: ${formatBytes(stat.size)}\nFiles: ${data.files.length}\n${data.files.map(f => `  • ${f.name}`).join('\n')}`,
      result: `ZIP created: ${data.files.length} files (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to create ZIP: ${err.message}`, result: '', error: err.message }
  }
}

export function readZip(filePath: string): FileResult {
  try {
    const AdmZip = require('adm-zip')
    const zip = new AdmZip(filePath)
    const entries = zip.getEntries()
    const stat = statSync(filePath)

    const lines = [
      `Read ZIP: ${filePath}`,
      `Size: ${formatBytes(stat.size)}`,
      `Entries: ${entries.length}`,
      '',
      '── Contents ──',
    ]
    for (const entry of entries) {
      lines.push(`  ${entry.isDirectory ? '📁' : '📄'} ${entry.entryName} (${formatBytes(entry.header.size)})`)
    }

    return {
      success: true,
      log: lines.join('\n'),
      result: `ZIP contains ${entries.length} entries (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to read ZIP: ${err.message}`, result: '', error: err.message }
  }
}

// ═══════════════════════════════════════════════
// YAML
// ═══════════════════════════════════════════════

export function writeYaml(filePath: string, data: any): FileResult {
  try {
    const yaml = require('js-yaml')
    const output = yaml.dump(data, { indent: 2, lineWidth: 120 })
    writeFileSync(filePath, output, 'utf-8')
    const stat = statSync(filePath)

    return {
      success: true,
      log: `Created YAML: ${filePath}\nSize: ${formatBytes(stat.size)}\n\n── Content ──\n${output.substring(0, 500)}`,
      result: `YAML created (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to create YAML: ${err.message}`, result: '', error: err.message }
  }
}

export function readYaml(filePath: string): FileResult {
  try {
    const yaml = require('js-yaml')
    const raw = readFileSync(filePath, 'utf-8')
    const data = yaml.load(raw)
    const stat = statSync(filePath)

    return {
      success: true,
      log: `Read YAML: ${filePath}\nSize: ${formatBytes(stat.size)}\n\n── Parsed ──\n${JSON.stringify(data, null, 2).substring(0, 1000)}`,
      result: `YAML parsed (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to read YAML: ${err.message}`, result: '', error: err.message }
  }
}

// ═══════════════════════════════════════════════
// Router: detect file type and dispatch
// ═══════════════════════════════════════════════

export async function writeRichFile(filePath: string, data: any): Promise<FileResult> {
  const ext = extname(filePath).toLowerCase()

  switch (ext) {
    case '.xlsx':
    case '.xls': {
      // Normalize: if data doesn't have sheets array, wrap it
      let excelData = data
      if (!excelData.sheets || !Array.isArray(excelData.sheets)) {
        // Maybe LLM sent { name, headers, rows } directly (single sheet)
        if (excelData.rows || excelData.headers) {
          excelData = { sheets: [{ name: excelData.name || 'Sheet1', headers: excelData.headers, rows: excelData.rows || [] }] }
        } else {
          // Last resort: wrap whatever we have
          excelData = { sheets: [{ name: 'Sheet1', headers: ['Data'], rows: [[JSON.stringify(data)]] }] }
        }
      }
      return writeExcel(filePath, excelData)
    }
    case '.docx':
      return writeDocx(filePath, data)
    case '.pdf':
      return writePdf(filePath, data)
    case '.pptx':
      return writePptx(filePath, data)
    case '.csv':
      return writeCsv(filePath, data)
    case '.zip':
      return writeZip(filePath, data)
    case '.yaml':
    case '.yml':
      return writeYaml(filePath, data)
    default:
      // Plain text
      try {
        const content = typeof data === 'string' ? data : (data.content || JSON.stringify(data, null, 2))
        writeFileSync(filePath, content, 'utf-8')
        const stat = statSync(filePath)
        return {
          success: true,
          log: `Created: ${filePath}\nSize: ${formatBytes(stat.size)}\n\n── Content ──\n${content.substring(0, 500)}`,
          result: `File created (${formatBytes(stat.size)})`,
        }
      } catch (err: any) {
        return { success: false, log: `Failed: ${err.message}`, result: '', error: err.message }
      }
  }
}

export async function readRichFile(filePath: string): Promise<FileResult> {
  const ext = extname(filePath).toLowerCase()

  switch (ext) {
    case '.xlsx':
    case '.xls':
      return readExcel(filePath)
    case '.docx':
      return readDocx(filePath)
    case '.pdf':
      return readPdf(filePath)
    case '.csv':
      return readCsv(filePath)
    case '.zip':
    case '.rar':
    case '.7z':
      return readZip(filePath)
    case '.yaml':
    case '.yml':
      return readYaml(filePath)
    default:
      // Plain text
      try {
        const content = readFileSync(filePath, 'utf-8')
        const stat = statSync(filePath)
        return {
          success: true,
          log: `Read: ${filePath}\nSize: ${formatBytes(stat.size)}\n\n── Content ──\n${content.substring(0, 2000)}${content.length > 2000 ? '\n...(truncated)' : ''}`,
          result: `Read ${formatBytes(stat.size)}`,
        }
      } catch (err: any) {
        return { success: false, log: `Failed: ${err.message}`, result: '', error: err.message }
      }
  }
}

/** Check if a file extension is a rich/binary type needing structured data */
export function isRichFileType(fileName: string): boolean {
  const ext = extname(fileName).toLowerCase()
  return ['.xlsx', '.xls', '.docx', '.pdf', '.pptx', '.csv', '.zip'].includes(ext)
}
