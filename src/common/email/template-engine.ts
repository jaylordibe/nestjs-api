import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as Handlebars from 'handlebars';
import * as fs from 'fs';
import * as path from 'path';

// Variable shapes for every template. Adding a key here tells TypeScript
// the template exists — `sendTemplate` call sites then get full type
// checking on the `vars` argument.
export interface EmailTemplates {
  'email-verification-link': { verifyUrl: string; firstName: string };
  'password-reset-otp': { otp: string; expiresInMinutes: number };
  'password-changed-notification': { firstName: string; occurredAt: string };
}

export type EmailTemplateKey = keyof EmailTemplates;

// Subjects are stored here rather than in a separate `.subject.hbs` file
// per template — most transactional subjects are short static strings
// ("Verify your email"), and when they do need variables ("Welcome,
// {{firstName}}") the function form interpolates with full type safety.
// The typed shape forces a subject to exist for every template declared
// in EmailTemplates above — a missing entry is a compile error.
type SubjectDefinition<K extends EmailTemplateKey> =
  | string
  | ((vars: EmailTemplates[K]) => string);

const TEMPLATE_SUBJECTS: {
  [K in EmailTemplateKey]: SubjectDefinition<K>;
} = {
  'email-verification-link': 'Verify your email',
  'password-reset-otp': 'Reset your password',
  'password-changed-notification': 'Your password was changed',
};

// Templates live in `./templates/<name>.html.hbs` with an optional
// `./templates/<name>.text.hbs` for a richer plain-text body. When the
// .text.hbs is absent, the plain-text fallback is derived by stripping
// HTML from the body.
//
// To add a new template:
//   1. Add `<name>` + variable shape to EmailTemplates above.
//   2. Add `<name>` + subject string or function to TEMPLATE_SUBJECTS.
//   3. Drop `<name>.html.hbs` into ./templates/.
//   4. Call emailService.sendTemplate('<name>', to, vars).
//
// Templates compile at module init and cache — zero runtime overhead
// after boot, and a typo in a `{{var}}` reference surfaces at startup
// rather than on the first email send.

interface CompiledTemplate {
  html: HandlebarsTemplateDelegate;
  text: HandlebarsTemplateDelegate | null;
}

@Injectable()
export class EmailTemplateEngine implements OnModuleInit {
  private readonly logger = new Logger(EmailTemplateEngine.name);
  private readonly compiled = new Map<string, CompiledTemplate>();

  onModuleInit(): void {
    // Resolve relative to this file so it works regardless of CWD.
    // Both src/ (ts-node) and dist/ (compiled) keep the templates
    // co-located — see nest-cli.json `compilerOptions.assets`.
    const dir = path.join(__dirname, 'templates');
    const files = fs.readdirSync(dir);
    const keys = new Set<string>();
    for (const file of files) {
      const match = /^(.+)\.(html|text)\.hbs$/.exec(file);
      if (match) keys.add(match[1]);
    }

    for (const key of keys) {
      const htmlPath = path.join(dir, `${key}.html.hbs`);
      const textPath = path.join(dir, `${key}.text.hbs`);
      if (!fs.existsSync(htmlPath)) {
        this.logger.warn(`Template "${key}" missing .html.hbs — skipping`);
        continue;
      }
      this.compiled.set(key, {
        html: Handlebars.compile(fs.readFileSync(htmlPath, 'utf-8')),
        text: fs.existsSync(textPath)
          ? Handlebars.compile(fs.readFileSync(textPath, 'utf-8'))
          : null,
      });
    }
    this.logger.log(
      `Loaded ${this.compiled.size} email template(s): ${[...this.compiled.keys()].join(', ')}`,
    );
  }

  render<K extends EmailTemplateKey>(
    key: K,
    vars: EmailTemplates[K],
  ): { subject: string; html: string; text: string } {
    const t = this.compiled.get(key);
    if (!t) {
      throw new Error(
        `Unknown email template: "${key}" — did you add ${key}.html.hbs to the templates directory?`,
      );
    }
    const subjectDef = TEMPLATE_SUBJECTS[key];
    // Explicit annotation because TS can't narrow a generic conditional
    // type (`SubjectDefinition<K>`) through a typeof guard.
    const subject: string =
      typeof subjectDef === 'function' ? subjectDef(vars) : subjectDef;
    const html = t.html(vars).trim();
    const text = t.text ? t.text(vars).trim() : this.htmlToText(html);
    return { subject: subject.trim(), html, text };
  }

  // Minimal HTML → text converter for the auto-derived plain-text
  // fallback. Adequate for the template library shipped here (simple
  // transactional emails). For richer content, provide an explicit
  // `<name>.text.hbs` alongside the html template.
  private htmlToText(html: string): string {
    return html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
