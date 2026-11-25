import { STUDIO_ROOT, startServer } from "./app.ts";
import "./routes.ts";

const port = Number(process.env.STUDIO_PORT ?? 4747);
const project = process.env.STUDIO_PROJECT ?? "bringup";
const s = await startServer({ root: process.env.STUDIO_ROOT ?? STUDIO_ROOT, port, project });
console.log(`bringup-studio: ${s.url} (project ${project})`);
