// Bun preload — registers happy-dom so React 19 + @testing-library/react
// run in a browser-shaped environment.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://app.example.test" });

// `IS_REACT_ACT_ENVIRONMENT` is the React 19 marker that quiets "act"
// warnings during state updates from outside `act(...)`. Setting it
// globally is the recommended pattern for non-React-Native test runners.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
