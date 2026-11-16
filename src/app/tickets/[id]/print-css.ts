/**
 * Print rules for one ticket per page. A style element, not a CSS module: this app's Tailwind pipeline does not
 * compile `:global`, and the ticket page's CSP allows inline styles. Black and white here are the paper, so a
 * door scanner can read the QR in either theme.
 */
export const TICKET_PRINT_CSS = `
.ticket-qr {
  width: 240px;
  max-width: 100%;
}
.ticket-qr svg {
  display: block;
  width: 240px;
  height: auto;
  max-width: 100%;
}
.ticket-sheet {
  overflow-wrap: anywhere;
}
@media print {
  header,
  footer,
  .no-print {
    display: none !important;
  }
  body {
    background: white !important;
    color: black !important;
  }
  main {
    max-width: none !important;
    padding: 0 !important;
  }
  .ticket-sheet {
    break-inside: avoid;
    page-break-inside: avoid;
    page-break-after: always;
    break-after: page;
    background: white !important;
    color: black !important;
    border: none !important;
  }
  .ticket-sheet:last-of-type {
    page-break-after: auto;
    break-after: auto;
  }
  .ticket-qr svg {
    width: 280px !important;
    height: 280px !important;
  }
}
`;
