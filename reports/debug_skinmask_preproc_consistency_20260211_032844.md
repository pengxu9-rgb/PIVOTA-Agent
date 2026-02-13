# Skinmask Preprocess Consistency Debug

- run_id: 20260211_032844
- generated_at: 2026-02-11T03:28:44.970Z
- dataset: fasseg
- onnx: artifacts/skinmask_v1.onnx
- limit: 20
- sample_seed: skinmask_preproc_consistency_v1
- shuffle: false
- threshold: mean/std abs diff > 0.05
- comparable_samples: 20

## Channel Summary (A=Python train preprocess, B=Node ONNX preprocess)

| channel | A mean | B mean | abs diff | A std | B std | abs diff |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0.1891 | 0.1898 | 0.0007 | 1.1414 | 1.1418 | 0.0004 |
| 1 | 0.0289 | 0.0305 | 0.0016 | 1.0548 | 1.0556 | 0.0008 |
| 2 | -0.0446 | -0.0432 | 0.0014 | 0.9718 | 0.9726 | 0.0008 |

## Output Summary

| metric | A (Python) | B (Node) | delta (B-A) |
|---|---:|---:|---:|
| skin_prob_mean | 0.1589 | 0.1594 | 0.0005 |
| pred_skin_ratio | 0.2284 | 0.2383 | 0.0099 |

## Per-sample

| sample_hash | A resize | B resize | A ch0 | B ch0 | A ch1 | B ch1 | A ch2 | B ch2 | A skin_prob_mean | B skin_prob_mean | A pred_skin_ratio | B pred_skin_ratio | fail_reason |
|---|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---|
| 3ccfb65e9d0102210b44 | 512x512 | 512x512 | min=-2.0837 max=2.2489 mean=0.5233 std=1.2482 | min=-2.1179 max=2.2489 mean=0.5213 std=1.2503 | min=-2.0357 max=2.3585 mean=0.1534 std=0.9471 | min=-2.0357 max=2.3936 mean=0.1523 std=0.9484 | min=-1.8044 max=2.3437 mean=0.0242 std=0.9817 | min=-1.8044 max=2.5703 mean=0.0229 std=0.9826 | 0.1624 | 0.1685 | 0.3462 | 0.39 | - |
| c9029882de9826977e38 | 512x512 | 512x512 | min=-2.0837 max=2.2489 mean=0.4177 std=1.1989 | min=-2.1179 max=2.2489 mean=0.4164 std=1.1994 | min=-2.0357 max=2.306 mean=0.0264 std=0.9625 | min=-2.0357 max=2.2185 mean=0.0254 std=0.9627 | min=-1.8044 max=2.3437 mean=-0.1792 std=1.0004 | min=-1.8044 max=2.3786 mean=-0.1803 std=1.0005 | 0.1555 | 0.1578 | 0.218 | 0.2373 | - |
| 716b5b663eb25ecee2b7 | 512x512 | 512x512 | min=-2.1179 max=2.2318 mean=-0.3019 std=1.3777 | min=-2.1179 max=2.2489 mean=-0.3026 std=1.3783 | min=-2.0357 max=2.4111 mean=-0.4893 std=1.0079 | min=-2.0357 max=2.341 mean=-0.4891 std=1.0082 | min=-1.8044 max=2.64 mean=-0.5613 std=0.8885 | min=-1.8044 max=2.4134 mean=-0.5613 std=0.8889 | 0.1388 | 0.1427 | 0.027 | 0.0649 | - |
| 76d47437c3effa9e5833 | 512x512 | 512x512 | min=-2.1179 max=2.2489 mean=-0.2595 std=1.4208 | min=-2.1179 max=2.2489 mean=-0.2603 std=1.4209 | min=-2.0357 max=2.3585 mean=-0.5571 std=1.0449 | min=-2.0357 max=2.4286 mean=-0.5568 std=1.0446 | min=-1.8044 max=2.5877 mean=-0.6002 std=0.8817 | min=-1.8044 max=2.64 mean=-0.6003 std=0.8817 | 0.165 | 0.1701 | 0.2537 | 0.3143 | - |
| 23050e77db571bae2b25 | 512x512 | 512x512 | min=-2.1179 max=2.1462 mean=0.7381 std=0.779 | min=-2.1179 max=2.1462 mean=0.7384 std=0.7799 | min=-1.9482 max=2.4286 mean=0.7574 std=1.045 | min=-1.9482 max=2.4286 mean=0.7585 std=1.0461 | min=-1.8044 max=2.64 mean=0.4652 std=0.9936 | min=-1.8044 max=2.64 mean=0.466 std=0.9944 | 0.1208 | 0.1212 | 0 | 0 | - |
| d42ca83b2ee6e27c168a | 512x512 | 512x512 | min=-2.1179 max=2.0948 mean=0.1556 std=1.2177 | min=-2.1179 max=2.1119 mean=0.1556 std=1.2177 | min=-2.0357 max=2.0259 mean=0.2489 std=1.1648 | min=-2.0357 max=1.9909 mean=0.2501 std=1.1653 | min=-1.8044 max=1.9254 mean=-0.0047 std=0.9286 | min=-1.8044 max=1.9254 mean=-0.0039 std=0.9289 | 0.1248 | 0.124 | 0.0215 | 0.0173 | - |
| 485734a2d36a71759e22 | 512x512 | 512x512 | min=-2.1008 max=2.1975 mean=0.6359 std=0.9491 | min=-2.0494 max=2.2147 mean=0.6362 std=0.9497 | min=-2.0357 max=2.4286 mean=0.2835 std=0.9857 | min=-2.0357 max=2.4286 mean=0.2855 std=0.9875 | min=-1.8044 max=2.4308 mean=-0.0793 std=0.9335 | min=-1.8044 max=2.3263 mean=-0.0777 std=0.9344 | 0.1628 | 0.1634 | 0.342 | 0.3423 | - |
| 0bb932eea409e2c2e6e4 | 512x512 | 512x512 | min=-2.0665 max=2.0777 mean=0.4831 std=1.104 | min=-2.0665 max=2.0777 mean=0.4835 std=1.1034 | min=-2.0357 max=2.0609 mean=0.2915 std=1.0066 | min=-2.0007 max=2.0784 mean=0.2933 std=1.0064 | min=-1.8044 max=2.1694 mean=0.1224 std=0.8395 | min=-1.8044 max=2.1694 mean=0.1234 std=0.8391 | 0.1603 | 0.1615 | 0.1317 | 0.1461 | - |
| 0635cbd45b6a3c2d6668 | 512x512 | 512x512 | min=-2.1179 max=2.2318 mean=-0.1617 std=1.4937 | min=-2.1008 max=2.2489 mean=-0.16 std=1.4931 | min=-2.0182 max=2.1134 mean=-0.1872 std=1.3823 | min=-2.0357 max=2.0609 mean=-0.184 std=1.3828 | min=-1.8044 max=2.2043 mean=-0.282 std=1.1164 | min=-1.8044 max=2.2391 mean=-0.2796 std=1.1165 | 0.148 | 0.1495 | 0.1637 | 0.1831 | - |
| 626fb82add0bbb868801 | 512x512 | 512x512 | min=-2.0665 max=1.8037 mean=0.1759 std=1.0494 | min=-2.0665 max=1.8037 mean=0.1763 std=1.0496 | min=-2.0007 max=2.0434 mean=0.259 std=1.106 | min=-1.9482 max=2.0434 mean=0.2604 std=1.1065 | min=-1.8044 max=1.3154 mean=0.021 std=0.8787 | min=-1.8044 max=1.3154 mean=0.022 std=0.879 | 0.1356 | 0.1372 | 0.006 | 0.009 | - |
| 839bb918b45229ce3699 | 512x512 | 512x512 | min=-1.9809 max=2.2489 mean=0.5085 std=1.2185 | min=-2.0494 max=2.2489 mean=0.5085 std=1.2186 | min=-1.8782 max=2.3936 mean=0.4654 std=1.1043 | min=-1.9657 max=2.4286 mean=0.4667 std=1.1049 | min=-1.787 max=2.6226 mean=0.2872 std=0.9605 | min=-1.8044 max=2.64 mean=0.2879 std=0.9606 | 0.1567 | 0.1571 | 0.3378 | 0.3417 | - |
| 1a6872a601cb6fa24e7b | 512x512 | 512x512 | min=-2.0152 max=2.2489 mean=0.6621 std=1.165 | min=-2.0152 max=2.2489 mean=0.6622 std=1.1655 | min=-1.8606 max=2.4286 mean=0.6257 std=1.0018 | min=-1.8606 max=2.4286 mean=0.6266 std=1.0025 | min=-1.8044 max=2.4831 mean=0.3779 std=0.9032 | min=-1.8044 max=2.518 mean=0.3785 std=0.9038 | 0.1785 | 0.1792 | 0.4573 | 0.4654 | - |
| 20d4a1903718a1c60112 | 512x512 | 512x512 | min=-2.1179 max=2.0777 mean=0.4566 std=1.1221 | min=-2.1179 max=2.0777 mean=0.4578 std=1.1213 | min=-1.9657 max=2.0259 mean=0.3766 std=0.9912 | min=-1.9657 max=1.9909 mean=0.3796 std=0.9915 | min=-1.8044 max=1.3851 mean=0.0979 std=0.8309 | min=-1.8044 max=1.3851 mean=0.1001 std=0.8308 | 0.1698 | 0.1709 | 0.3088 | 0.3156 | - |
| bc8725147f5fc25d614d | 512x512 | 512x512 | min=-2.0494 max=2.0092 mean=0.1266 std=1.1432 | min=-2.0323 max=2.0434 mean=0.1296 std=1.1444 | min=-1.9482 max=2.2535 mean=0.0548 std=1.2285 | min=-1.9657 max=2.271 mean=0.0581 std=1.2302 | min=-1.5953 max=2.6226 mean=0.2824 std=1.2371 | min=-1.6127 max=2.64 mean=0.2857 std=1.2389 | 0.1509 | 0.1508 | 0.053 | 0.0577 | - |
| f4f706870531da42f8cd | 512x512 | 512x512 | min=-1.6727 max=2.0605 mean=0.3949 std=1.0643 | min=-1.6898 max=2.0263 mean=0.3979 std=1.0648 | min=-1.5805 max=2.1134 mean=0.0154 std=1.1559 | min=-1.563 max=2.0959 mean=0.0188 std=1.1571 | min=-1.299 max=2.2217 mean=0.0775 std=1.1402 | min=-1.299 max=2.2043 mean=0.0808 std=1.1417 | 0.2028 | 0.1912 | 0.4589 | 0.4105 | - |
| 496a1f609d21c5d5e5bd | 512x512 | 512x512 | min=-1.9638 max=1.855 mean=-0.2038 std=0.9599 | min=-1.9638 max=1.855 mean=-0.202 std=0.9604 | min=-1.8431 max=2.0434 mean=-0.1968 std=0.9483 | min=-1.8431 max=2.0434 mean=-0.1948 std=0.949 | min=-1.5081 max=2.1694 mean=-0.1742 std=0.8867 | min=-1.4907 max=2.1694 mean=-0.1723 std=0.8876 | 0.1538 | 0.152 | 0.1343 | 0.1326 | - |
| 4381a7495eef1008ed06 | 512x512 | 512x512 | min=-2.0323 max=1.6495 mean=0.174 std=1.0676 | min=-2.0323 max=1.6495 mean=0.1765 std=1.0685 | min=-2.0357 max=1.8859 mean=-0.1245 std=1.1328 | min=-2.0357 max=1.8859 mean=-0.1214 std=1.1343 | min=-1.787 max=2.152 mean=0.0878 std=1.1619 | min=-1.787 max=2.152 mean=0.091 std=1.1636 | 0.1855 | 0.1845 | 0.4664 | 0.4624 | - |
| b889a82fa85319bb1dff | 512x512 | 512x512 | min=-2.1179 max=1.8208 mean=-0.2439 std=1.056 | min=-2.1179 max=1.8037 mean=-0.2419 std=1.0567 | min=-2.0357 max=2.0434 mean=-0.5155 std=0.9869 | min=-2.0357 max=2.0609 mean=-0.513 std=0.9886 | min=-1.8044 max=2.396 mean=-0.3309 std=0.9599 | min=-1.8044 max=2.396 mean=-0.3282 std=0.9618 | 0.1867 | 0.1897 | 0.3448 | 0.3558 | - |
| e0eeceebc88dae90dfa0 | 512x512 | 512x512 | min=-1.9295 max=1.8722 mean=-0.2153 std=1.1673 | min=-1.9295 max=1.8722 mean=-0.2152 std=1.1676 | min=-1.8256 max=1.7283 mean=-0.4304 std=0.9819 | min=-1.8256 max=1.7283 mean=-0.4296 std=0.9826 | min=-1.5604 max=2.0474 mean=-0.3008 std=0.9295 | min=-1.5604 max=2.0474 mean=-0.2997 std=0.9304 | 0.1414 | 0.1416 | 0.1025 | 0.1379 | - |
| f2f5ffb707f930e593d7 | 512x512 | 512x512 | min=-1.9467 max=1.7694 mean=-0.2836 std=1.026 | min=-1.9467 max=1.8037 mean=-0.2817 std=1.0266 | min=-1.8431 max=2.0609 mean=-0.479 std=0.9112 | min=-1.8431 max=2.0959 mean=-0.4759 std=0.9133 | min=-1.5604 max=2.5703 mean=-0.2229 std=0.9832 | min=-1.5953 max=2.5877 mean=-0.2192 std=0.9863 | 0.1776 | 0.1751 | 0.3942 | 0.3827 | - |

## Artifacts

- md: `reports/debug_skinmask_preproc_consistency_20260211_032844.md`
- jsonl: `reports/debug_skinmask_preproc_consistency_20260211_032844.jsonl`

