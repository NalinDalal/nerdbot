import { renderToString } from "react-dom/server";
import App from "./app";
const html = renderToString(<App />);
console.log("Rendered HTML:", html.substring(0, 200));
