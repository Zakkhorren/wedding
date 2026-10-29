import {
  prepareManualPage,
  applyManualPage,
  manualUrl,
} from "./manual-rsvp-bundle.mjs";
const args = process.argv.slice(2);
try {
  if (args.includes("--apply")) {
    applyManualPage();
    console.log(
      "Only the local main-document override was updated. Refresh " +
        manualUrl +
        " in your ordinary browser with DevTools open.",
    );
  } else {
    const index = args.indexOf("--sitekey");
    if (index < 0)
      throw Error(
        "Use --sitekey PUBLIC_TEST_SITEKEY, then follow MANUAL-E2E-WINDOWS.md. Never supply a secret.",
      );
    const paths = prepareManualPage(args[index + 1]);
    console.log("Prepared local HTML: " + paths.document);
    console.log(
      "Select this initially empty Overrides folder in ordinary Edge/Chrome: " +
        paths.overrides,
    );
    console.log(
      "Open " +
        manualUrl +
        " and save ONLY its Document with Override content, then run this command with --apply.",
    );
  }
  console.log(
    "No browser launched, no requests sent, no infrastructure changed. Do not open preview.html as file://.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
