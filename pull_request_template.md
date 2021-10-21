# Code Review Processes
## New Feature Review
Before submitting a pull request for new review, make sure the following is done:
* Design doc is created and posted here: [Insert Link](https://github.com/RedVeil/set-protocol-v2/../../../../curveFactoryMetapoolAmmAdapter.md)
* Code cleanliness and completeness is addressed via [guidelines](https://app.gitbook.com/@setprotocol-1/s/set/smart-contract-engineering/sc-code-review-process)

README Checks
- [x] README has proper context for the reviewer to understand what the code includes, any important design considerations, and areas to pay more attention to

Code Checks
- [x] Add explanatory comments. If there is complex code that requires specific context or understanding, note that in a comment
- [x] Remove unncessary comments. Any comments that do not add additional context, information, etc. should be removed
- [ ] Add javadocs. 
- [x] Scrub through the code for inconsistencies (e.g. removing extra spaces)
- [x] Ensure there are not any .onlys in spec files


Broader Considerations
- [x] Ensure variable, function and event naming is clear, consistent, and reflective for the scope of the code.
- [x] Consider if certain pieces of logic should be placed in a different library, module
