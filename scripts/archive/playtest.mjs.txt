// The old persistent-profile launcher sent requests directly from the browser.
// Gateway mode requires a separately configured backend; this harness is not adapted.
console.error('The legacy direct-provider playtest is disabled in gateway mode. Use npm run preview:local for the isolated fake backend, or run the extension build against an explicitly configured gateway.')
process.exitCode = 1
