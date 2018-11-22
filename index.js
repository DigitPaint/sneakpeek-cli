#!/usr/bin/env node

const { execSync } = require('child_process');
const yargs = require('yargs');
const archiver = require('archiver');
const fs = require('fs');
const request = require('superagent');
const ProgressBar = require('progress');
const shellescape = require('shell-escape');
const tmp = require('tmp');

const DEFAULTS = {
  path: null,
  project: null,
  gitlabProject: null,
  apiUrl: process.env['SNEAKPEEK_API_URL'] || "https://api.peek.digitpaint.nl",
  apiKey: process.env['SNEAKPEEK_API_KEY'] || null
}

function getCiInfo() {
  const info = {}

  info.sha = process.env["CI_BUILD_REF"]

  if(process.env["CI_BUILD_TAG"]) {
    info.reftype = "tag"
    info.ref = process.env["CI_BUILD_TAG"]
  } else {
    info.reftype = "branch"
    info.ref = process.env["CI_BUILD_REF_NAME"]
  }

  return info;
}

function getGitInfo(rev = "HEAD") {
  const info = {}

  info.sha = git('show', '--format=format:"%H"', '-s', rev)

  info.reftype = "tag"
  info.ref = git('describe', '--tags', '--exact-match', rev)

  if(!info.ref) {
    info.reftype = "branch"
    info.ref = git('rev-parse', '--abbrev-ref', rev)
  }

  if(!info.ref) {
    info.reftype = null
  }

  return info
}

function git(...args) {
  try {
    const command = ['git'].concat(args);
    const escapedCommand = shellescape(command) + " 2>&1";
    const result = execSync(escapedCommand).toString().trim();
    return result.replace(/^"/, "").replace(/"$/, "")
  } catch(e) {
    return null;
  }
}

function gitInfo() {
  if(process.env["CI"]) {
    return getCiInfo();
  } else {
    return getGitInfo();
  }
}

function sneakpeekUrl(base, project, git) {
  const url = [base, 'projects', encodeURIComponent(project)]

  const reftypeToUrlMap = {
    "branch" : "branches",
    "tag" : "tags"
  }

  if(!reftypeToUrlMap[git.reftype]) {
    throw("Current project is neither on a tag nor a branch");
  }

  url.push(reftypeToUrlMap[git.reftype])
  url.push(encodeURIComponent(git.ref))

  return url.join("/")
}

function zip(sourcePath) {
  console.log(`Zipping: ${sourcePath}`)
  return new Promise((resolve, reject) => {
    const tmpFile = tmp.tmpNameSync();
    const output = fs.createWriteStream(tmpFile);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Sets the compression level.
    });

    // good practice to catch this error explicitly
    archive.on('error', function(err) {
      reject(err);
    });

    output.on('finish', () => {
      resolve(tmpFile);
    })

    // pipe archive data to the file
    archive.pipe(output);

    // append files from directory and put them at root
    archive.directory(sourcePath, false);

    // finalize the archive (ie we are done appending files but streams have to finish yet)
    // 'close', 'end' or 'finish' may be fired right after calling this method so register to them beforehand
    archive.finalize();
  })
}

function upload(zipfile, options = {}) {
  console.log(`Uploading to ${options.apiUrl}`);
  const metadata = gitInfo();
  const url = sneakpeekUrl(options.apiUrl, options.project, metadata);
  const req = request.post(url).type('form');

  if(options.apiKey && options.apiKey !== "") {
    req.set("Authorization", options.apiKey)
  }

  req.field('sha', metadata.sha);
  req.field('gitlab_project', options.gitlabProject);
  req.attach('file', zipfile);

  let bar;
  let last = 0;

  req.on('progress', e => {
    if (!bar) {
      total = e.total;
      bar = new ProgressBar(':bar', { total });
    } else {
      bar.tick(e.loaded - last);
      last = e.loaded;
    }
  })

  return req.then((r) => {
    console.log(r.body);
  }).catch((e) => {
    if(e.status == 401) {
      console.error("Unauthorized API access try again with a (differten) API-key")
    } else {
      console.error("Upload failed")
      console.log(e);
    }
  })
}

function validatePath(dir) {
  const stat = fs.statSync(dir);

  if(!stat.isDirectory()) {
    throw(`Path ${dir} is not a directory`)
  }
}

function uploadCommand(argv) {
  const options = Object.assign({}, DEFAULTS, {
    project: argv.project,
    gitlabProject: argv.gitlabProject,
    path: argv.path,
    apiUrl: argv.apiUrl,
    apiKey: argv.apiKey
  });

  // Validate path
  validatePath(options.path)

  // Create zip file
  zip(options.path).then((zipfile) => {
    // Upload zip file
    return upload(zipfile, options)
  });
}

yargs
  .usage("$0 <cmd> [options]")
  .alias('h', 'help')
  .command("upload <path>", 'Upload a path to sneakpeek',
    (yargs) => {
      return yargs.positional('path', {
          describe: 'local path to upload to sneakpeek',
          type: 'string'
        })
        .option('project', {
          alias: 'p',
          describe: 'name of the sneakpeek project',
          type: 'string'
        })
        .option('gitlab-project', {
          alias: 'g',
          describe: 'group/name of gitlab project',
          type: 'string'
        })
        .option('api-url', {
          describe: 'API URL to upload to. Can also be set through SNEAKPEEK_API_URL env variable',
          default: DEFAULTS.apiUrl,
          type: 'string'
        })
        .option('api-key', {
          describe: 'API key to use. Can also be set through SNEAKPEEK_API_KEY env variable',
          default: DEFAULTS.apiKey,
          type: 'string'
        })
        .demandOption(['path', 'project', 'gitlab-project'])
    },
    uploadCommand
  )
  .demandCommand(1, `Pass --help to see all available commands and options.`)
  .strict()
  .showHelpOnFail(true)
  .recommendCommands()
  .parse(process.argv.slice(2))
