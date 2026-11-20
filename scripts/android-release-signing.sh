#!/bin/bash
# Re-applies release signing after `expo prebuild --platform android`, which
# regenerates android/ from scratch. Reads values from secrets/ (gitignored);
# never prints them.
set -euo pipefail
cd "$(dirname "$0")/.."
grep -q TELEVO_RELEASE_STORE_FILE android/gradle.properties || grep -v '^#' secrets/android-release-signing.properties >> android/gradle.properties
python3 - <<'PY'
p='android/app/build.gradle'; s=open(p).read()
if 'TELEVO_RELEASE_STORE_FILE' not in s:
    a=s.index('    signingConfigs {')
    s=s[:a]+'''    signingConfigs {
        release {
            if (project.hasProperty('TELEVO_RELEASE_STORE_FILE')) {
                storeFile file(TELEVO_RELEASE_STORE_FILE)
                storePassword TELEVO_RELEASE_STORE_PASSWORD
                keyAlias TELEVO_RELEASE_KEY_ALIAS
                keyPassword TELEVO_RELEASE_KEY_PASSWORD
            }
        }
'''+s[a+len('    signingConfigs {\n'):]
    i=s.index('        release {',s.index('buildTypes'))
    j=s.index('signingConfig signingConfigs.debug',i)
    s=s[:j]+'signingConfig signingConfigs.release'+s[j+len('signingConfig signingConfigs.debug'):]
    open(p,'w').write(s)
PY
echo "release signing applied"
