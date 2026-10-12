// Zero-dependency vsix packager: Node stdlib only (fs, path, zlib).
// A vsix is a plain zip archive; the minimal writer below produces it
// without archiver nor vsce and their vulnerable dependency trees.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Go back to the project root directory
const projectRoot = path.resolve(__dirname, '..');

// Read the metadata from package.json
const packageJson = require(path.join(projectRoot, 'package.json'));

// Optional --target=<platform> (e.g. linux-x64, win32-x64) for a platform
// specific vsix; without it the vsix is universal
const targetArg = process.argv.find(aArg => aArg.startsWith('--target='));
const targetPlatform = targetArg ? targetArg.split('=')[1] : null;
const vsixSuffix = targetPlatform ? `-${targetPlatform}` : '';
const vsixFilename = path.join(projectRoot, `${packageJson.name}-${packageJson.version}${vsixSuffix}.vsix`);

// Escape a value interpolated into the generated XML manifests.
function escapeXml(aValue) {
    return String(aValue)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ------------------------------------------------------------
// CRC32 (zip checksum)
// ------------------------------------------------------------
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let tableIndex = 0; tableIndex < 256; tableIndex++) {
        let crcValue = tableIndex;
        for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
            crcValue = (crcValue & 1) ? (0xEDB88320 ^ (crcValue >>> 1)) : (crcValue >>> 1);
        }
        table[tableIndex] = crcValue >>> 0;
    }
    return table;
})();

function crc32(aBuffer) {
    let crcValue = 0xFFFFFFFF;
    for (let byteIndex = 0; byteIndex < aBuffer.length; byteIndex++) {
        crcValue = CRC_TABLE[(crcValue ^ aBuffer[byteIndex]) & 0xFF] ^ (crcValue >>> 8);
    }
    return (crcValue ^ 0xFFFFFFFF) >>> 0;
}

// ------------------------------------------------------------
// Minimal zip writer (deflate entries + central directory + end record)
// ------------------------------------------------------------
function toDosDateTime(aDate) {
    const dosTime = (aDate.getHours() << 11) | (aDate.getMinutes() << 5) | (aDate.getSeconds() >> 1);
    const dosDate = (((aDate.getFullYear() - 1980) & 0x7F) << 9) | ((aDate.getMonth() + 1) << 5) | aDate.getDate();
    return { dosTime: dosTime, dosDate: dosDate };
}

class ZipWriter {
    constructor() {
        this.localChunks = [];
        this.centralEntries = [];
        this.currentOffset = 0;
        this.stamp = toDosDateTime(new Date());
    }

    addFile(aEntryName, aDataBuffer) {
        const nameBuffer = Buffer.from(aEntryName.replace(/\\/g, '/'), 'utf8');
        const compressedData = zlib.deflateRawSync(aDataBuffer, { level: 9 });
        const crcValue = crc32(aDataBuffer);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034B50, 0);                   // local file header signature
        localHeader.writeUInt16LE(20, 4);                           // version needed to extract
        localHeader.writeUInt16LE(0x0800, 6);                       // flags: UTF-8 names
        localHeader.writeUInt16LE(8, 8);                            // compression: deflate
        localHeader.writeUInt16LE(this.stamp.dosTime, 10);
        localHeader.writeUInt16LE(this.stamp.dosDate, 12);
        localHeader.writeUInt32LE(crcValue, 14);
        localHeader.writeUInt32LE(compressedData.length, 18);
        localHeader.writeUInt32LE(aDataBuffer.length, 22);
        localHeader.writeUInt16LE(nameBuffer.length, 26);
        localHeader.writeUInt16LE(0, 28);                           // extra field length

        this.centralEntries.push({
            nameBuffer: nameBuffer,
            crcValue: crcValue,
            compressedSize: compressedData.length,
            uncompressedSize: aDataBuffer.length,
            localHeaderOffset: this.currentOffset,
        });
        this.localChunks.push(localHeader, nameBuffer, compressedData);
        this.currentOffset += localHeader.length + nameBuffer.length + compressedData.length;
    }

    toBuffer() {
        const centralChunks = [];
        let centralSize = 0;
        for (const entry of this.centralEntries) {
            const centralHeader = Buffer.alloc(46);
            centralHeader.writeUInt32LE(0x02014B50, 0);             // central directory signature
            centralHeader.writeUInt16LE(20, 4);                     // version made by
            centralHeader.writeUInt16LE(20, 6);                     // version needed to extract
            centralHeader.writeUInt16LE(0x0800, 8);                 // flags: UTF-8 names
            centralHeader.writeUInt16LE(8, 10);                     // compression: deflate
            centralHeader.writeUInt16LE(this.stamp.dosTime, 12);
            centralHeader.writeUInt16LE(this.stamp.dosDate, 14);
            centralHeader.writeUInt32LE(entry.crcValue, 16);
            centralHeader.writeUInt32LE(entry.compressedSize, 20);
            centralHeader.writeUInt32LE(entry.uncompressedSize, 24);
            centralHeader.writeUInt16LE(entry.nameBuffer.length, 28);
            centralHeader.writeUInt16LE(0, 30);                     // extra field length
            centralHeader.writeUInt16LE(0, 32);                     // comment length
            centralHeader.writeUInt16LE(0, 34);                     // disk number start
            centralHeader.writeUInt16LE(0, 36);                     // internal attributes
            centralHeader.writeUInt32LE(0, 38);                     // external attributes
            centralHeader.writeUInt32LE(entry.localHeaderOffset, 42);
            centralChunks.push(centralHeader, entry.nameBuffer);
            centralSize += centralHeader.length + entry.nameBuffer.length;
        }

        const endRecord = Buffer.alloc(22);
        endRecord.writeUInt32LE(0x06054B50, 0);                     // end of central directory signature
        endRecord.writeUInt16LE(0, 4);                              // disk number
        endRecord.writeUInt16LE(0, 6);                              // central directory start disk
        endRecord.writeUInt16LE(this.centralEntries.length, 8);
        endRecord.writeUInt16LE(this.centralEntries.length, 10);
        endRecord.writeUInt32LE(centralSize, 12);
        endRecord.writeUInt32LE(this.currentOffset, 16);
        endRecord.writeUInt16LE(0, 20);                             // comment length

        return Buffer.concat([...this.localChunks, ...centralChunks, endRecord]);
    }
}

// ------------------------------------------------------------
// Archive content
// ------------------------------------------------------------

// Individual files to include: source path -> path inside extension/.
// The license gets a .txt extension like vsce does, so every part of
// the package has a content type
const filesToInclude = [
    ['package.json', 'package.json'],
    ['readme.md', 'readme.md'],
    ['changelog.md', 'changelog.md'],
    ['LICENSE', 'LICENSE.txt'],
];

// Folders to include
const foldersToInclude = [
    'medias',
    'out',
    'syntaxes',
    'doc'
];

// Entry name inside extension/ -> file content
const extensionFiles = new Map();

// Recursively collect a folder and its content
function collectDirectory(aDirPath, aEntryPrefix) {
    const dirEntries = fs.readdirSync(aDirPath, { withFileTypes: true });
    for (const dirEntry of dirEntries) {
        const fullPath = path.join(aDirPath, dirEntry.name);
        const entryName = `${aEntryPrefix}/${dirEntry.name}`;
        if (dirEntry.isDirectory()) {
            collectDirectory(fullPath, entryName);
        } else {
            extensionFiles.set(entryName, fs.readFileSync(fullPath));
        }
    }
}

filesToInclude.forEach(([sourceName, entryName]) => {
    const filePath = path.join(projectRoot, sourceName);
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
        extensionFiles.set(entryName, fs.readFileSync(filePath));
    } else {
        console.warn(`Warning: the file '${sourceName}' does not exist or is not a file.`);
    }
});

foldersToInclude.forEach(folderName => {
    const folderPath = path.join(projectRoot, folderName);
    if (fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory()) {
        collectDirectory(folderPath, folderName);
    } else {
        console.warn(`Warning: the folder '${folderName}' does not exist or is not a directory.`);
    }
});

// ------------------------------------------------------------
// [Content_Types].xml: one entry per file extension in the package
// ------------------------------------------------------------
const CONTENT_TYPES = {
    '.json': 'application/json',
    '.vsixmanifest': 'text/xml',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.cjs': 'application/javascript',
    '.ts': 'video/mp2t',
    '.map': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.css': 'text/css',
    '.html': 'text/html',
    '.xml': 'text/xml',
    '.xsd': 'text/xml',
    '.yml': 'text/yaml',
    '.yaml': 'text/yaml',
    '.wasm': 'application/wasm',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

// Every part of the package needs a content type: a Default per file
// extension, and an Override for the files without extension
const usedExtensions = new Set(['.vsixmanifest']);
const extensionlessEntries = [];
for (const entryName of extensionFiles.keys()) {
    const fileExtension = path.extname(entryName).toLowerCase();
    if (fileExtension) {
        usedExtensions.add(fileExtension);
    } else {
        extensionlessEntries.push(entryName);
    }
}

const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${[...usedExtensions].map(ext => `  <Default Extension="${escapeXml(ext)}" ContentType="${CONTENT_TYPES[ext] || DEFAULT_CONTENT_TYPE}"/>`).join('\n')}${extensionlessEntries.map(entryName => `
  <Override PartName="/extension/${escapeXml(entryName)}" ContentType="${DEFAULT_CONTENT_TYPE}"/>`).join('')}
</Types>`;

// ------------------------------------------------------------
// extension.vsixmanifest, mirroring what vsce generates
// ------------------------------------------------------------
const isWebExtension = Boolean(packageJson.browser);

// vsce adds 'web' to the extension kinds and a __web_extension tag for
// extensions with a browser entry point; the Marketplace relies on them
const extensionKinds = [].concat(packageJson.extensionKind || ['workspace']);
if (isWebExtension && !extensionKinds.includes('web')) {
    extensionKinds.push('web');
}
const tags = [...(packageJson.keywords || [])];
if (isWebExtension) {
    tags.push('__web_extension');
}

const repositoryUrl = typeof packageJson.repository === 'string'
    ? packageJson.repository
    : packageJson.repository && packageJson.repository.url;

const properties = [
    ['Microsoft.VisualStudio.Code.Engine', packageJson.engines.vscode],
    ['Microsoft.VisualStudio.Code.ExtensionDependencies', (packageJson.extensionDependencies || []).join(',')],
    ['Microsoft.VisualStudio.Code.ExtensionPack', (packageJson.extensionPack || []).join(',')],
    ['Microsoft.VisualStudio.Code.ExtensionKind', extensionKinds.join(',')],
    ['Microsoft.VisualStudio.Code.LocalizedLanguages', ''],
];
if (repositoryUrl) {
    properties.push(
        ['Microsoft.VisualStudio.Services.Links.Source', repositoryUrl],
        ['Microsoft.VisualStudio.Services.Links.Getstarted', repositoryUrl],
        ['Microsoft.VisualStudio.Services.Links.GitHub', repositoryUrl],
        ['Microsoft.VisualStudio.Services.Links.Support', `${repositoryUrl.replace(/\.git$/, '')}/issues`],
        ['Microsoft.VisualStudio.Services.Links.Learn', `${repositoryUrl.replace(/\.git$/, '')}#readme`],
    );
}
if (packageJson.galleryBanner) {
    properties.push(
        ['Microsoft.VisualStudio.Services.Branding.Color', packageJson.galleryBanner.color],
        ['Microsoft.VisualStudio.Services.Branding.Theme', packageJson.galleryBanner.theme],
    );
}
properties.push(
    ['Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown', 'true'],
    ['Microsoft.VisualStudio.Services.Content.Pricing', 'Free'],
);

// Top level readme and changelog, whatever their case
const findTopLevelEntry = aFileName => [...extensionFiles.keys()].find(entryName => entryName.toLowerCase() === aFileName);
const readmeEntry = findTopLevelEntry('readme.md');
const changelogEntry = findTopLevelEntry('changelog.md');

const assets = [
    ['Microsoft.VisualStudio.Code.Manifest', 'extension/package.json'],
];
if (readmeEntry) {
    assets.push(['Microsoft.VisualStudio.Services.Content.Details', `extension/${readmeEntry}`]);
}
if (changelogEntry) {
    assets.push(['Microsoft.VisualStudio.Services.Content.Changelog', `extension/${changelogEntry}`]);
}
if (extensionFiles.has('LICENSE.txt')) {
    assets.push(['Microsoft.VisualStudio.Services.Content.License', 'extension/LICENSE.txt']);
}
if (packageJson.icon && extensionFiles.has(packageJson.icon)) {
    assets.push(['Microsoft.VisualStudio.Services.Icons.Default', `extension/${packageJson.icon}`]);
}

const vsixManifestXml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(packageJson.name)}" Version="${escapeXml(packageJson.version)}" Publisher="${escapeXml(packageJson.publisher)}"${targetPlatform ? ` TargetPlatform="${escapeXml(targetPlatform)}"` : ''} />
    <DisplayName>${escapeXml(packageJson.displayName || packageJson.name)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(packageJson.description)}</Description>
    <Tags>${escapeXml(tags.join(','))}</Tags>
    <Categories>${escapeXml((packageJson.categories || []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
${properties.map(([id, value]) => `      <Property Id="${id}" Value="${escapeXml(value)}" />`).join('\n')}
    </Properties>${extensionFiles.has('LICENSE.txt') ? `
    <License>extension/LICENSE.txt</License>` : ''}${packageJson.icon && extensionFiles.has(packageJson.icon) ? `
    <Icon>extension/${escapeXml(packageJson.icon)}</Icon>` : ''}
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
${assets.map(([type, assetPath]) => `    <Asset Type="${type}" Path="${escapeXml(assetPath)}" Addressable="true" />`).join('\n')}
  </Assets>
</PackageManifest>`;

// ------------------------------------------------------------
// Zip it, manifests first like vsce
// ------------------------------------------------------------
const zipWriter = new ZipWriter();
zipWriter.addFile('extension.vsixmanifest', Buffer.from(vsixManifestXml, 'utf8'));
zipWriter.addFile('[Content_Types].xml', Buffer.from(contentTypesXml, 'utf8'));
for (const [entryName, fileContent] of extensionFiles) {
    zipWriter.addFile(`extension/${entryName}`, fileContent);
}

// Write the package file
const vsixBuffer = zipWriter.toBuffer();
fs.writeFileSync(vsixFilename, vsixBuffer);
console.log(`[CMakeGraph] Extension packaged successfully: ${vsixFilename} (${zipWriter.centralEntries.length} files, ${(vsixBuffer.length / 1024).toFixed(1)} KiB)`);
