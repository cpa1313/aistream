// Newest first: explicit dateAdded (catalog add date) outranks releaseDate.
// Records with neither keep their original order at the end of the list.
const dramas = [...(window.DB_DRAMAS_P1||[]), ...(window.DB_DRAMAS_P2||[]), ...(window.DB_DRAMAS_P3||[])]
  .sort((a, b) => String(b.dateAdded || b.releaseDate || '').localeCompare(String(a.dateAdded || a.releaseDate || '')));
