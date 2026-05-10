// tsup.config.ts
import { defineConfig } from "tsdown";

export default defineConfig({
	// Entry file(s)
	entry: ["index.ts"],

	// Output formats
	format: ["cjs", "esm"],

	// Generate declaration files
	dts: true,

	// Clean dist folder before build
	clean: true,

	// Target ES2018 for good balance
	target: "es2018",

	// Bundle dependencies (adjust based on your needs), // Bundle all dependencies
	// or
	// external: ['some-package'], // Mark specific packages as external

	// Enable sourcemaps
	sourcemap: true,

	// Optional: Minification
	minify: false,

	// Optional: Tree-shaking
	treeshake: true,
	deps: {
		alwaysBundle: [],
	},
});
