import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		exclude: ["**/node_modules/**"],
		setupFiles: ["./test/setup.ts"],
		hookTimeout: 30_000,
		testTimeout: 15_000,
		// Explicit single-worker pool: the default maxWorkers derivation hits a
		// tinypool min/max conflict on high-core hosts in this vitest major.
		pool: "forks",
		poolOptions: { forks: { minForks: 1, maxForks: 4 } },
		unstubGlobals: true,
		clearMocks: true,
		restoreMocks: true,
		passWithNoTests: true,
	},
});
