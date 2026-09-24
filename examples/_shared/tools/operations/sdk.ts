import { createRequire } from "node:module";
const require = createRequire(new URL("./dependencies/package.json", import.meta.url));
interface Locator { fill(text: string): Promise<void>; click(): Promise<void>; textContent(): Promise<string | null>; waitFor(options?: object): Promise<void> }
interface Download { saveAs(path: string): Promise<void>; suggestedFilename(): string }
interface Route { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }
export interface Page { route(pattern: string, handler: (route: Route) => Promise<void>): Promise<void>; goto(url: string): Promise<unknown>; getByLabel(label: string): Locator; getByRole(role: string, options: { name: string }): Locator; locator(selector: string): Locator; waitForEvent(event: "download"): Promise<Download>; screenshot(options: { path: string }): Promise<unknown>; setDefaultTimeout(ms: number): void }
interface Browser { newPage(options?: object): Promise<Page>; close(): Promise<void> }
interface Desktop { firstWindow(): Promise<Page>; evaluate<T>(callback: (electron: { BrowserWindow: { getAllWindows(): { isVisible(): boolean }[] } }) => T): Promise<T>; close(): Promise<void> }
export const browserSdk = () => require("playwright") as { chromium: { launch(options?: object): Promise<Browser> }; _electron: { launch(options: object): Promise<Desktop> } };
export const electronPath = () => require("electron") as string;
export const mailSdk = () => require("nodemailer") as { createTransport(options: object): { sendMail(message: object): Promise<{ messageId: string }>; close(): void } };
export interface SmtpServer { listen(port: number, host: string, callback: () => void): void; server: { address(): { port: number } }; close(callback: (error?: Error) => void): void }
export const smtpSdk = () => require("smtp-server") as { SMTPServer: new (options: object) => SmtpServer };
