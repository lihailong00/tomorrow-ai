`red-circle.png` is a generated 256 × 256 RGB PNG: a red circle on white.
It contains no text, instructions or user data. The image probe asks for its
color and shape without including the expected answer in the prompt.

The embedding probe sends one fixed Chinese reminder sentence and validates
the returned vector using the same 1024-dimension, numeric and nonzero checks
as production semantic search. Neither probe stores results or user content.
Testing is independent of the feature enable switch and never enables it.
