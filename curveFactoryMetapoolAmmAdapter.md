## Curve FactoryMetapool Amm Adapter
This PR contains a new amm adapter for curve and test for it.

### What for?
The CurveFactoryMetapoolAmmAdapter allows user to add or remove liquidity in curve metapools that were created with the metapoolFactory (0x0959158b6040D32d04c301A72CBFD6b39E21c9AE). An example for a pool like this is MIM-3CRV (0x5a6A4D54456819380173272A5E8E9B9904BdF41B). <b>Its important to notice that only the exotic stable coin (MIM) and 3CRV can be deposited or withdrawn.</b> Using dai/usdc/usdt would need some extra zap interaction.  

### Why only these pool?
Curve has in large two types of metapools. Metapools that were created before the metapoolFactory and pools afterwards. They are quite different in terms of interfaces. Before the factory for example LP-Token were standalone ERC-20 contracts that didnt share the address with their pools. This alone validates some assumptions of the AmmModule. Additionally they do not allow to remove or add liquidity for a recipient.
It might be possible to also create an adapter for older modules but its atleast far more complicated.