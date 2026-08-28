export async function appendGoogleSheetRow(input: {
  accessToken: string;
  spreadsheetId: string;
  range: string;
  values: unknown[];
}): Promise<void> {
  if (!/^[a-zA-Z0-9-_]+$/.test(input.spreadsheetId)) throw new Error("Invalid spreadsheet id");
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${input.spreadsheetId}/values/${encodeURIComponent(input.range)}:append`,
  );
  url.searchParams.set("valueInputOption", "USER_ENTERED");
  url.searchParams.set("insertDataOption", "INSERT_ROWS");
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ values: [input.values] }),
  });
  if (!response.ok) throw new Error(`Google Sheets append failed with ${response.status}`);
}
