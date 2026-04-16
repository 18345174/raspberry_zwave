let xlsxModulePromise: Promise<typeof import("xlsx")> | null = null;

async function loadXlsx() {
  xlsxModulePromise ??= import("xlsx");
  return xlsxModulePromise;
}

export function downloadTextFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.URL.revokeObjectURL(url);
}

export async function downloadXlsxFromCsv(
  csvContent: string,
  filename: string,
  sheetName = "Test Report",
): Promise<void> {
  const XLSX = await loadXlsx();
  const workbook = XLSX.read(csvContent, { type: "string" });
  const firstSheetName = workbook.SheetNames[0];

  if (firstSheetName && firstSheetName !== sheetName) {
    workbook.Sheets[sheetName] = workbook.Sheets[firstSheetName];
    delete workbook.Sheets[firstSheetName];
    workbook.SheetNames[0] = sheetName;
  }

  XLSX.writeFile(workbook, filename, { compression: true });
}
