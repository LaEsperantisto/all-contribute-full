-- The bed carries its own picture on the top and bottom faces, like the grass
-- and wood blocks already do (0019): seen from above it is the cover with the
-- pillow at the head end and the frame as a rail around the edge; from below it
-- is the slatted frame over a dark gap. The four sides keep the existing
-- side-on picture, so a bed lying in the world reads as a bed from any angle.
UPDATE blocks SET texture_top = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAgklEQVR42mPY1BXzH4RPhIT8h7FJwQw1EWb/N1hZYcV9Ojo45UAYpBduwLevH7FikCHYxDEMePHsAdEY5jKyDABpBtFYDTh/ai9RGMUFoNDHF1BEBSLIRHIwihdwYZALcWG4AfgUEZ0O0G0dWBeQFQagUKXIBYQyDk4DZhe4/qcEAwB2BHQp1Bw7MAAAAABJRU5ErkJggg==' WHERE id = 'builtin:bed';
UPDATE blocks SET texture_bottom = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZElEQVR42mPY1BXzH4RrIszAOMtLD87Gh2H6GNANIBbDDYAJiAiI/J9d4Ap2AYwNonGxYfowDMCniaoGwMIKpwEwr1DNBehhM/BhgGIAsVGH1wUgQwbOCwNrALbMREyOpFpuBACojNFADeEbugAAAABJRU5ErkJggg==' WHERE id = 'builtin:bed';
