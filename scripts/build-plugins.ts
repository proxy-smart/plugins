// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Generates the Proxy Smart agent plugins from source/.
 *
 * The marketplace installs each plugin with `git-subdir`, a sparse checkout of that one
 * directory, so the skills cannot be shared by path and are copied in at build time.
 * Targets marked `committed` are written into the repo; `--check` fails when they drift.
 *
 *   bun run plugins                               write the committed plugins
 *   bun run plugins:check                         fail if they are out of date (CI)
 *   bun run plugins:customer -- --url https://…   build the customer artifact
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { staleToolNames } from './tool-names'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const SOURCE_DIR = join(REPO_ROOT, 'source')
const PLUGINS_DIR = REPO_ROOT

const AUTHOR = { name: 'Max Health Inc.', url: 'https://maxhealth.tech' }
const REPOSITORY = 'https://github.com/proxy-smart/plugins'
const LICENSE = 'AGPL-3.0-or-later OR LicenseRef-Commercial'
const MARKETPLACE = 'max-health'
const VERSION = '0.1.0'

interface Target {
  committed: boolean
  displayName: string
  headline: string
  tagline: string
  serverKey: string
  url: string
  homepage: string
  skills: string[]
  keywords: string[]
  brandColor: string
  category: string
  endpointHeading: string
  endpointBody: string
  description: string
  longDescription: string
}

interface Artifact {
  path: string
  content: string
}

interface SkillInfo {
  slug: string
  summary: string
  sourceDir: string
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function claudeManifest(name: string, t: Target): string {
  return json({
    $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
    name,
    displayName: t.displayName,
    description: t.description,
    version: VERSION,
    author: AUTHOR,
    homepage: t.homepage,
    repository: REPOSITORY,
    license: LICENSE,
    keywords: t.keywords,
  })
}

function codexManifest(name: string, t: Target): string {
  return json({
    name,
    version: VERSION,
    description: t.description,
    author: AUTHOR,
    homepage: t.homepage,
    repository: REPOSITORY,
    license: LICENSE,
    keywords: t.keywords,
    skills: './skills/',
    mcpServers: './.mcp.codex.json',
    interface: {
      displayName: t.displayName,
      shortDescription: t.tagline,
      longDescription: t.longDescription,
      developerName: AUTHOR.name,
      category: t.category,
      websiteURL: t.homepage,
      brandColor: t.brandColor,
    },
  })
}

function mcpConfig(t: Target): string {
  const url = t.committed ? t.url : `\${PROXY_SMART_URL:-${originOf(t.url)}}/mcp`
  return json({ mcpServers: { [t.serverKey]: { type: 'http', url } } })
}

function originOf(url: string): string {
  const scheme = url.indexOf('://')
  if (scheme === -1) return url
  const slash = url.indexOf('/', scheme + 3)
  return slash === -1 ? url : url.slice(0, slash)
}

function installSection(name: string, t: Target): string {
  if (!t.committed) {
    return [
      '## Install',
      '',
      'This plugin is shipped to you as a directory rather than through a marketplace. Point your',
      'client at it directly:',
      '',
      '```',
      `claude --plugin-dir ./${name}`,
      '```',
      '',
      'To install it permanently, copy the directory somewhere stable and add it to your',
      '`enabledPlugins`, or commit it to your own infrastructure repo and install from there.',
    ].join('\n')
  }
  return [
    '## Install — Claude Code',
    '',
    '```',
    `/plugin marketplace add Max-Health-Inc/maxhealth.tech`,
    `/plugin install ${name}@${MARKETPLACE}`,
    '```',
    '',
    'Then restart Claude Code (or `/reload-plugins`). Try it locally first with',
    `\`claude --plugin-dir ./${name}\`.`,
    '',
    '## Install — Codex',
    '',
    '```',
    `codex plugin marketplace add Max-Health-Inc/maxhealth.tech`,
    `codex plugin add ${name}@${MARKETPLACE}`,
    '```',
  ].join('\n')
}

async function skillList(t: Target): Promise<string> {
  const lines = ['It bundles:', '']
  for (const { slug, summary } of await skillsFor(t)) {
    lines.push(`- **The \`${slug}\` skill** — ${summary}`)
  }
  return lines.join('\n')
}

async function skillTree(t: Target): Promise<string> {
  const slugs = (await skillsFor(t)).map((s) => s.slug)
  return slugs
    .map((slug, i) => {
      const branch = i === slugs.length - 1 ? '└──' : '├──'
      return `    ${branch} ${slug}/SKILL.md`
    })
    .join('\n')
}

async function skillsFor(t: Target): Promise<SkillInfo[]> {
  const found: SkillInfo[] = []
  for (const group of t.skills) {
    const groupDir = join(SOURCE_DIR, group)
    for (const slug of (await readdir(groupDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      const text = await readFile(join(groupDir, slug, 'SKILL.md'), 'utf8')
      found.push({ slug, summary: firstSentence(descriptionOf(text)), sourceDir: join(groupDir, slug) })
    }
  }
  return found
}

function descriptionOf(source: string): string {
  const markdown = source.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown)
  if (!match) return ''
  const body = match[1]
  const start = /^description:[ \t]*(>-|>|\|-|\||.*)$/m.exec(body)
  if (!start) return ''
  if (!start[1].startsWith('>') && !start[1].startsWith('|')) return start[1].trim()
  const after = body.slice(start.index + start[0].length).replace(/^\r?\n/, '')
  const folded: string[] = []
  for (const line of after.split('\n')) {
    if (!/^\s+\S/.test(line)) break
    folded.push(line.trim())
  }
  return folded.join(' ')
}

function firstSentence(text: string): string {
  const stop = text.indexOf('. ')
  return stop === -1 ? text : text.slice(0, stop + 1)
}

async function readme(name: string, t: Target): Promise<string> {
  const template = await readFile(join(SOURCE_DIR, 'README.md.tmpl'), 'utf8')
  return template
    .replaceAll('__NAME__', name)
    .replaceAll('__HEADLINE__', t.headline)
    .replaceAll('__SERVER_KEY__', t.serverKey)
    .replaceAll('__URL__', t.url)
    .replaceAll('__ENDPOINT_HEADING__', t.endpointHeading)
    .replaceAll('__ENDPOINT_BODY__', t.endpointBody)
    .replaceAll('__SKILL_LIST__', await skillList(t))
    .replaceAll('__SKILL_TREE__', await skillTree(t))
    .replaceAll('__INSTALL__', installSection(name, t))
}

async function artifactsFor(name: string, t: Target): Promise<Artifact[]> {
  return [
    { path: '.claude-plugin/plugin.json', content: claudeManifest(name, t) },
    { path: '.codex-plugin/plugin.json', content: codexManifest(name, t) },
    { path: '.mcp.json', content: mcpConfig(t) },
    { path: '.mcp.codex.json', content: mcpConfig(t) },
    { path: 'README.md', content: await readme(name, t) },
  ]
}

async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(path)))
    else files.push(path)
  }
  return files
}

function posix(path: string): string {
  return path.split(sep).join('/')
}

async function skillFilesFor(t: Target): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const skill of await skillsFor(t)) {
    for (const file of await filesUnder(skill.sourceDir)) {
      files.set(posix(join('skills', skill.slug, relative(skill.sourceDir, file))), file)
    }
  }
  return files
}

async function writeTarget(outDir: string, name: string, t: Target): Promise<void> {
  for (const artifact of await artifactsFor(name, t)) {
    const file = join(outDir, artifact.path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, toCrlf(artifact.content), 'utf8')
  }
  const skillsOut = join(outDir, 'skills')
  await rm(skillsOut, { recursive: true, force: true })
  for (const skill of await skillsFor(t)) {
    await cp(skill.sourceDir, join(skillsOut, skill.slug), { recursive: true })
  }
}

function sameContent(a: string, b: string): boolean {
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')
}

function toCrlf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
}

async function driftFor(outDir: string, name: string, t: Target): Promise<string[]> {
  const expected = new Map<string, () => Promise<string>>()
  for (const artifact of await artifactsFor(name, t)) {
    expected.set(artifact.path, async () => artifact.content)
  }
  for (const [path, source] of await skillFilesFor(t)) {
    expected.set(path, () => readFile(source, 'utf8'))
  }

  const drift: string[] = []
  for (const [path, want] of expected) {
    const file = join(outDir, path)
    const shown = posix(relative(REPO_ROOT, file))
    if (!existsSync(file)) drift.push(`${shown} is missing`)
    else if (!sameContent(await readFile(file, 'utf8'), await want())) drift.push(`${shown} differs from source/`)
  }
  for (const file of await filesUnder(join(outDir, 'skills'))) {
    if (!expected.has(posix(relative(outDir, file)))) {
      drift.push(`${posix(relative(REPO_ROOT, file))} has no counterpart in source/`)
    }
  }
  return drift
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function toTarget(name: string, raw: unknown): Target {
  if (!isRecord(raw)) throw new Error(`target "${name}" must be an object`)
  const { committed, skills, keywords } = raw
  if (typeof committed !== 'boolean') throw new Error(`target "${name}".committed must be a boolean`)
  if (!isStringArray(skills)) throw new Error(`target "${name}".skills must be a string array`)
  if (!isStringArray(keywords)) throw new Error(`target "${name}".keywords must be a string array`)
  const text = (field: string): string => {
    const value = raw[field]
    if (typeof value !== 'string') throw new Error(`target "${name}".${field} must be a string`)
    return value
  }
  return {
    committed,
    skills,
    keywords,
    displayName: text('displayName'),
    headline: text('headline'),
    tagline: text('tagline'),
    serverKey: text('serverKey'),
    url: text('url'),
    homepage: text('homepage'),
    brandColor: text('brandColor'),
    category: text('category'),
    endpointHeading: text('endpointHeading'),
    endpointBody: text('endpointBody'),
    description: text('description'),
    longDescription: text('longDescription'),
  }
}

async function loadTargets(): Promise<Map<string, Target>> {
  const raw: unknown = JSON.parse(await readFile(join(SOURCE_DIR, 'targets.json'), 'utf8'))
  if (!isRecord(raw)) throw new Error('source/targets.json must be an object')
  return new Map(Object.entries(raw).map(([name, value]) => [name, toTarget(name, value)]))
}

async function buildCustomer(rawUrl: string, outArg: string | undefined): Promise<void> {
  const url = rawUrl.replace(/\/+$/, '')
  if (!url.startsWith('https://')) {
    throw new Error(`--url must be https, got: ${rawUrl}`)
  }
  const name = 'proxy-smart'
  const source = (await loadTargets()).get(name)
  if (!source) throw new Error(`source/targets.json has no "${name}" target`)

  const mcpUrl = `${url}/mcp`
  const resolve = (text: string): string =>
    text.replaceAll('__CUSTOMER_URL__', mcpUrl).replaceAll('__CUSTOMER_URL_ORIGIN__', url)
  const target: Target = {
    ...source,
    url: mcpUrl,
    homepage: url,
    endpointBody: resolve(source.endpointBody),
  }

  const outDir = outArg ? join(REPO_ROOT, outArg) : join(REPO_ROOT, 'dist', 'plugins', name)
  await rm(outDir, { recursive: true, force: true })
  await writeTarget(outDir, name, target)
  console.log(`wrote ${relative(REPO_ROOT, outDir)}`)
  console.log(`   endpoint: ${mcpUrl}`)
  console.log(`   skills:   ${(await skillsFor(target)).map((s) => s.slug).join(', ')}`)
}

async function main(): Promise<void> {
  const committed = [...(await loadTargets())].filter(([, t]) => t.committed)

  const customerUrl = flag('url')
  if (customerUrl) {
    await buildCustomer(customerUrl, flag('out'))
    return
  }

  if (process.argv.includes('--check')) {
    const drift: string[] = []
    for (const [name, target] of committed) {
      drift.push(...(await driftFor(join(PLUGINS_DIR, name), name, target)))
    }
    const sources = await Promise.all(
      (await filesUnder(SOURCE_DIR)).map(async (file) => ({
        path: posix(relative(REPO_ROOT, file)),
        text: await readFile(file, 'utf8'),
      })),
    )
    drift.push(...(await staleToolNames(sources)))
    if (drift.length === 0) {
      console.log(`plugins are up to date (${committed.map(([n]) => n).join(', ')})`)
      return
    }
    console.error(
      'plugin directories are out of date. They are generated from source/ — run:\n' +
        '  bun run plugins\n\n' +
        drift.map((line) => `  - ${line}`).join('\n'),
    )
    process.exit(1)
  }

  for (const [name, target] of committed) {
    await writeTarget(join(PLUGINS_DIR, name), name, target)
    console.log(`wrote ${name} (${(await skillsFor(target)).map((s) => s.slug).join(', ')})`)
  }
}

main().catch((error: unknown) => {
  console.error('build-plugins failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
