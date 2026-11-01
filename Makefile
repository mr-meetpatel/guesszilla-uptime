.PHONY: setup dev check test test-e2e build db-local deploy
setup:
	npm ci
dev:
	npm run dev
check:
	npm run check
test:
	npm test
test-e2e:
	npm run test:e2e
build:
	npm run build
db-local:
	npm run db:local
deploy:
	npm run deploy
