// Global vitest setup: registers @testing-library/jest-dom's matchers on vitest's
// `expect` (toBeInTheDocument / toBeDisabled / …). This only extends the matcher
// surface — it needs no DOM at import time, so it is safe for the node-environment
// pure-lib suite too. UI tests opt into a DOM via a per-file `@vitest-environment
// jsdom` docblock and handle their own RTL `cleanup` (see tests/conductor-ui.test.tsx).
import '@testing-library/jest-dom/vitest';
