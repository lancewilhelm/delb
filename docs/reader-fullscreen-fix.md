# Fullscreen reader listener lifecycle

The reader previously called `rendition.start()` whenever its fullscreen control was toggled. In epubjs 0.3.93, another start call registers another set of manager section, resize, orientation and scroll handlers. Repeated toggles can therefore multiply event processing.

The candidate changes only this control: it updates fullscreen state, then awaits the existing layout refresh. That helper waits for the DOM update and animation frame before measuring, resizing and reporting the existing rendition. It preserves the rendition instead of reinitializing it.

`pnpm test:reader-fullscreen` exercises the actual component function with synthetic dependencies. Both tests fail on merged-main baseline `0a2fdbba1789d921e258a71f22842d7478d4c7de`, where the forbidden restart is invoked. With the candidate, entry and exit perform deliberate layout refreshes and the function waits for refresh completion. This is not a native-browser geometry or position-preservation test.

This independently useful lifecycle repair does not establish the cause of ordinary scrolling jumps that start without using the fullscreen control. Theme reapplication, continuous view insertion/trimming, content reflow and late restoration need separate diagnosis. This change does not alter scripting, dependencies, page/scroll modes, progress restoration or publication/deployment configuration.
