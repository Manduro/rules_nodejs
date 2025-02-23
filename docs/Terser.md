---
title: Terser
layout: default
stylesheet: docs
---
# Terser rules for Bazel

**WARNING: this is beta-quality software. Breaking changes are likely. Not recommended for production use without expert support.**

The Terser rules run the Terser JS minifier with Bazel.

Wraps the Terser CLI documented at https://github.com/terser-js/terser#command-line-usage


## Installation

Add the `@bazel/terser` npm package to your `devDependencies` in `package.json`.

Your `WORKSPACE` should declare a `yarn_install` or `npm_install` rule named `npm`.
It should then install the rules found in the npm packages using the `install_bazel_dependencies` function.
See https://github.com/bazelbuild/rules_nodejs/#quickstart

This causes the `@bazel/terser` package to be installed as a Bazel workspace named `npm_bazel_terser`.


## Installing with self-managed dependencies

If you didn't use the `yarn_install` or `npm_install` rule to create an `npm` workspace, you'll have to declare a rule in your root `BUILD.bazel` file to execute terser:

```python
# Create a terser rule to use in terser_minified#terser_bin
# attribute when using self-managed dependencies
nodejs_binary(
    name = "terser_bin",
    entry_point = "//:node_modules/terser/bin/uglifyjs",
    # Point bazel to your node_modules to find the entry point
    node_modules = ["//:node_modules"],
)
```

[name]: https://bazel.build/docs/build-ref.html#name
[label]: https://bazel.build/docs/build-ref.html#labels
[labels]: https://bazel.build/docs/build-ref.html#labels


## terser_minified

Run the terser minifier.

Typical example:
```python
load("@npm_bazel_terser//:index.bzl", "terser_minified")

terser_minified(
    name = "out.min",
    src = "input.js",
    config_file = "terser_config.json",
)
```

Note that the `name` attribute determines what the resulting files will be called.
So the example above will output `out.min.js` and `out.min.js.map` (since `sourcemap` defaults to `true`).
If the input is a directory, then the output will also be a directory, named after the `name` attribute.



### Usage

```
terser_minified(name, args, config_file, debug, sourcemap, src, terser_bin)
```



#### `name`
(*[name], mandatory*): A unique name for this target.


#### `args`
(*List of strings*): Additional command line arguments to pass to terser.

Terser only parses minify() args from the config file so additional arguments such as `--comments` may
be passed to the rule using this attribute. See https://github.com/terser/terser#command-line-usage for the
full list of terser CLI options.


#### `config_file`
(*[label]*): A JSON file containing Terser minify() options.

This is the file you would pass to the --config-file argument in terser's CLI.
https://github.com/terser-js/terser#minify-options documents the content of the file.

Bazel will make a copy of your config file, treating it as a template.

> Run bazel with `--subcommands` to see the path to the copied file.

If you use the magic strings `"bazel_debug"` or `"bazel_no_debug"`, these will be
replaced with `true` and `false` respecting the value of the `debug` attribute
or the `--compilation_mode=dbg` bazel flag.

For example,

```
{
    "compress": {
        "arrows": "bazel_no_debug"
    }
}
```
Will disable the `arrows` compression setting when debugging.

If `config_file` isn't supplied, Bazel will use a default config file.


#### `debug`
(*Boolean*): Configure terser to produce more readable output.

Instead of setting this attribute, consider using debugging compilation mode instead
bazel build --compilation_mode=dbg //my/terser:target
so that it only affects the current build.


#### `sourcemap`
(*Boolean*): Whether to produce a .js.map output


#### `src`
(*[label], mandatory*): File(s) to minify.

Can be a .js file, a rule producing .js files as its default output, or a rule producing a directory of .js files.

Note that you can pass multiple files to terser, which it will bundle together.
If you want to do this, you can pass a filegroup here.


#### `terser_bin`
(*[label]*): An executable target that runs Terser


