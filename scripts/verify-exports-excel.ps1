param([string]$Directory)
$ErrorActionPreference='Stop'
$excel=$null
try {
 $excel=New-Object -ComObject Excel.Application
 $excel.Visible=$false
 $excel.DisplayAlerts=$false
 $excel.AutomationSecurity=3
 $excel.AskToUpdateLinks=$false
 $results=@()
 foreach($file in Get-ChildItem -LiteralPath $Directory -Filter '*.xlsx'){
   $book=$null
   try{
    $book=$excel.Workbooks.Open($file.FullName,0,$true)
    $sheets=@()
    foreach($sheet in $book.Worksheets){$sheet.Activate();$sheets+=@{name=$sheet.Name;rows=$sheet.UsedRange.Rows.Count;columns=$sheet.UsedRange.Columns.Count;charts=$sheet.ChartObjects().Count;freeze=$book.Windows.Item(1).FreezePanes};}
    $book.ExportAsFixedFormat(0,(Join-Path $Directory ($file.BaseName+'-excel.pdf')))
    $results+=@{file=$file.Name;opened=$true;sheets=$sheets}
   } finally {if($book){$book.Close($false);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($book)}}
 }
 $results|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $Directory 'excel-validation.json') -Encoding UTF8
 Write-Output 'Native Excel open and PDF export completed for all synthetic samples.'
}finally{if($excel){$excel.Quit();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel)}}
