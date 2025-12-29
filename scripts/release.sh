#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_info() { echo -e "${BLUE}ℹ${NC} $1"; }
print_success() { echo -e "${GREEN}✓${NC} $1"; }
print_error() { echo -e "${RED}✗${NC} $1"; }
print_warning() { echo -e "${YELLOW}⚠${NC} $1"; }

if [ ! -f "package.json" ]; then
    print_error "package.json not found. Run from project root."
    exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
    print_error "Uncommitted changes. Commit or stash first."
    git status --short
    exit 1
fi

CURRENT_VERSION=$(cat package.json | grep '"version"' | head -1 | awk -F'"' '{print $4}')
print_info "Current version: ${CURRENT_VERSION}"

VERSION_TYPE=${1:-patch}

if [ "$VERSION_TYPE" != "patch" ] && [ "$VERSION_TYPE" != "minor" ] && [ "$VERSION_TYPE" != "major" ]; then
    print_error "Invalid version type: ${VERSION_TYPE}"
    echo "Usage: ./scripts/release.sh [patch|minor|major]"
    echo "  patch: 0.3.4 -> 0.3.5 (bug fixes)"
    echo "  minor: 0.3.4 -> 0.4.0 (new features)"
    echo "  major: 0.3.4 -> 1.0.0 (breaking changes)"
    exit 1
fi

IFS='.' read -r -a VERSION_PARTS <<< "$CURRENT_VERSION"
MAJOR="${VERSION_PARTS[0]}"
MINOR="${VERSION_PARTS[1]}"
PATCH="${VERSION_PARTS[2]}"

case $VERSION_TYPE in
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0
        PATCH=0
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0
        ;;
    patch)
        PATCH=$((PATCH + 1))
        ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
print_info "New version: ${NEW_VERSION}"

read -p "$(echo -e ${YELLOW}▶${NC} Release version ${NEW_VERSION}? [y/N]: )" -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_warning "Release cancelled"
    exit 0
fi

print_info "Starting release..."

print_info "Updating package.json..."
sed -i.bak "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" package.json
rm -f package.json.bak
print_success "Updated package.json"

print_info "Building..."
bun run build
print_success "Build complete"

print_info "Committing..."
git add package.json
git commit -m "release: v${NEW_VERSION}"
print_success "Committed"

print_info "Creating tag..."
git tag -a "v${NEW_VERSION}" -m "v${NEW_VERSION}"
print_success "Tag v${NEW_VERSION} created"

print_info "Pushing..."
git push origin main
git push origin "v${NEW_VERSION}"
print_success "Pushed"

echo
print_success "Release v${NEW_VERSION} complete!"
echo
print_info "GitHub Actions will publish to npm"
echo "https://github.com/elitan/velo/actions"
