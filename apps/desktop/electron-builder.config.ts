import { Configuration } from 'electron-builder'

const config: Configuration = {
  appId: 'com.wispyr.app',
  productName: 'Wispyr',
  copyright: 'Copyright © 2026 Wispyr Contributors',
  asar: true,

  directories: {
    output: 'dist',
    buildResources: 'build',
  },

  files: [
    'out/**/*',
    'node_modules/**/*',
    '!node_modules/**/*.map',
    '!node_modules/**/test/**',
  ],

  win: {
    icon: 'build/icon.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
    ],
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    artifactName: 'Wispyr-Setup-${version}.exe',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
  },

  portable: {
    artifactName: 'Wispyr-${version}-portable.exe',
    unpackDirName: 'Wispyr',
  },

  publish: {
    provider: 'github',
    owner: 'EldhosAji',
    repo: 'wispyr',
    releaseType: 'release',
  },

  mac: {
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
    icon: 'build/icon.icns',
  },
}

export default config
