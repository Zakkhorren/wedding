param([string]$File = '.qa/workerd-export.xlsx')
# Optional Windows compatibility test. Opens only a local synthetic file, read-only.
# Generate it first with: node tests/miniflare-smoke.mjs
$ErrorActionPreference = 'Stop'
$excelApp = $null
$testBook = $null
try {
  $excelApp = New-Object -ComObject Excel.Application
  $excelApp.Visible = $false
  $excelApp.DisplayAlerts = $false
  $excelApp.EnableEvents = $false
  $excelApp.AskToUpdateLinks = $false
  $excelApp.AutomationSecurity = 3
  $xlsxPath = (Resolve-Path -LiteralPath $File).Path
  $testBook = $excelApp.Workbooks.Open($xlsxPath, 0, $true)
  $testSheet = $testBook.Worksheets.Item(1)
  if ($testSheet.Cells.Item(1,1).Value2 -cne 'Компания / представитель') { throw 'Cyrillic header mismatch' }
  if ($testSheet.Cells.Item(1,11).Value2 -cne 'Дата ответа (МСК)') { throw 'Date header mismatch' }
  if ($testSheet.UsedRange.Columns.Count -ne 14) { throw 'Column count mismatch' }
  if ($testSheet.Columns.Item(10).ColumnWidth -lt 50) { throw 'Comment width mismatch' }
  if ($testSheet.Cells.Item(2,11).Text -notmatch '^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$') { throw 'Date display mismatch' }
  $hasCyrillic = $false
  $hasLiteralFormula = $false
  foreach ($cell in $testSheet.UsedRange.Cells) {
    if ($cell.HasFormula) { throw 'Unexpected formula' }
    if ($cell.Value2 -ceq 'Соня и Лёша') { $hasCyrillic = $true }
    if ($cell.Value2 -ceq '=HYPERLINK("https://invalid.test","test")') { $hasLiteralFormula = $true }
  }
  if (!$hasCyrillic -or !$hasLiteralFormula) { throw 'Missing literal user values' }
  Write-Output ('PASS Excel ' + $excelApp.Version + '; Cyrillic, 14 columns, widths, date=' + $testSheet.Cells.Item(2,11).Text + '; no formulas')
} finally {
  if ($null -ne $testBook) { $testBook.Close($false) }
  if ($null -ne $excelApp) {
    $excelApp.Quit()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excelApp)
  }
}
